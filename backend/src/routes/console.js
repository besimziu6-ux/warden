const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const store = require("../lib/store");
const docker = require("../lib/docker");
const { verifyPayload, findById, toPublic } = require("../lib/auth");

const BASE = path.resolve(__dirname, "../../../data/servers");
const MAX_LINES = 2000;

function consoleFile(id) {
  return path.join(BASE, String(id), "console.log");
}

function ensureDir(id) {
  const dir = path.dirname(consoleFile(id));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readHistory(id, n = 100) {
  try {
    const f = consoleFile(id);
    if (!fs.existsSync(f)) return [];
    const raw = fs.readFileSync(f, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

function appendLine(id, line) {
  ensureDir(id);
  try {
    fs.appendFileSync(consoleFile(id), String(line) + "\n", "utf8");
  } catch {
    return;
  }
}

function trimFile(id) {
  try {
    const f = consoleFile(id);
    if (!fs.existsSync(f)) return;
    const raw = fs.readFileSync(f, "utf8");
    const lines = raw.split("\n");
    const body = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    if (body.length <= MAX_LINES) return;
    fs.writeFileSync(f, body.slice(-MAX_LINES).join("\n") + "\n", "utf8");
  } catch {
    return;
  }
}

function push(id, line, mem) {
  mem.push(line);
  if (mem.length > MAX_LINES) mem.splice(0, mem.length - MAX_LINES);
  appendLine(id, line);
}

function tokenFromReq(req, query) {
  if (query && query.token) return String(query.token);
  const h = req.headers && req.headers.authorization;
  if (h) {
    const parts = String(h).split(" ");
    if (parts.length === 2 && parts[0] === "Bearer") return parts[1];
  }
  return null;
}

function canAccess(user, server) {
  if (!user || !server) return false;
  if (user.role === "admin") return true;
  const ownerId = server.ownerId || server.userId || null;
  if (ownerId && ownerId === user.id) return true;
  const ownerName = server.owner || server.username || null;
  if (ownerName && ownerName === user.username) return true;
  if (!ownerId && !ownerName) return true;
  return false;
}

function parseInput(msg) {
  const s = Buffer.isBuffer(msg) ? msg.toString("utf8") : String(msg);
  const t = s.trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t);
      const v = o.data ?? o.command ?? o.input ?? null;
      if (typeof v === "string" && v.trim()) return v.trim();
      return null;
    } catch {
      return t;
    }
  }
  return t;
}

let DockerCtor = null;
try {
  DockerCtor = require("dockerode");
} catch {
  DockerCtor = null;
}

async function attachDockerLogs(server, onLine) {
  if (!DockerCtor || !server.containerId) return null;
  const client = new DockerCtor();
  const container = client.getContainer(server.containerId);
  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 100,
  });
  stream.on("data", (chunk) => {
    const parts = chunk.toString("utf8").split("\n");
    for (const p of parts) {
      const line = p.replace(/^[\x00-\x08\x0b\x0c\x0e-\x1f]+/, "").trimEnd();
      if (line) onLine(line);
    }
  });
  return { stream, client, container };
}

async function execCommand(server, cmd, onLine) {
  if (!DockerCtor || !server.containerId) return false;
  try {
    const client = new DockerCtor();
    const container = client.getContainer(server.containerId);
    const exec = await container.exec({
      Cmd: ["sh", "-c", cmd],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    stream.on("data", (chunk) => {
      const parts = chunk.toString("utf8").split("\n");
      for (const p of parts) {
        const line = p.replace(/^[\x00-\x08\x0b\x0c\x0e-\x1f]+/, "").trimEnd();
        if (line) onLine(line);
      }
    });
    await new Promise((resolve) => stream.on("end", resolve));
    return true;
  } catch {
    return false;
  }
}

function attachConsole(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname = "";
    let query = {};
    try {
      const u = new URL(req.url || "", "http://localhost");
      pathname = u.pathname;
      query = Object.fromEntries(u.searchParams.entries());
    } catch {
      socket.destroy();
      return;
    }
    const m = pathname.match(/^\/ws\/servers\/([^/]+)\/console\/?$/);
    if (!m) {
      socket.destroy();
      return;
    }

    const id = decodeURIComponent(m[1]);
    const token = tokenFromReq(req, query);
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const payload = verifyPayload(token);
    if (!payload) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const full = findById(payload.sub);
    if (!full) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const user = toPublic(full);
    const server = store.get(id);
    if (!server) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!canAccess(user, server)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { server, user });
    });
  });

  wss.on("connection", (ws, req, ctx) => {
    const server = ctx.server;
    const id = server.id;
    const mem = [];
    let closed = false;
    let timer = null;
    let dockerHandle = null;

    const send = (line) => {
      if (closed || ws.readyState !== ws.OPEN) return;
      try {
        ws.send(line);
      } catch {
        return;
      }
    };
    const record = (line) => {
      push(id, line, mem);
      send(line);
    };

    for (const line of readHistory(id)) send(line);

    (async () => {
      await docker.check().catch(() => false);
      if (closed) return;
      if (!docker.isMock() && server.containerId && DockerCtor) {
        try {
          dockerHandle = await attachDockerLogs(server, (line) => record(line));
          if (dockerHandle) {
            dockerHandle.stream.on("end", () => record("[console] log stream ended"));
            dockerHandle.stream.on("error", () => record("[console] log stream error"));
            return;
          }
        } catch {
          dockerHandle = null;
        }
      }
      let n = mem.length;
      let announcedOffline = false;
      timer = setInterval(() => {
        if (closed) return;
        const cur = store.get(id);
        if (!cur || cur.status !== "running") {
          if (!announcedOffline) {
            announcedOffline = true;
            record("[console] server offline — start it to stream logs (mock mode: no container attached)");
          }
          return;
        }
        announcedOffline = false;
        n += 1;
        record(`[mock] ${new Date().toISOString()} server=${id} tick=${n}`);
      }, 1500);
    })();

    ws.on("message", async (msg) => {
      const cmd = parseInput(msg);
      if (!cmd) return;
      record(`> ${cmd}`);
      if (!docker.isMock() && server.containerId && DockerCtor) {
        const ok = await execCommand(server, cmd, (line) => record(line));
        if (ok) return;
      }
      record(`[mock] executed: ${cmd}`);
    });

    const cleanup = () => {
      closed = true;
      if (timer) clearInterval(timer);
      try {
        if (dockerHandle && dockerHandle.stream) dockerHandle.stream.destroy();
      } catch {
        return;
      }
      trimFile(id);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  return wss;
}

module.exports = { attachConsole, canAccess, consoleFile };
