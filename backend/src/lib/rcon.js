const fs = require("fs");
const net = require("net");
const path = require("path");

const SERVERS_BASE = path.resolve(__dirname, "../../../data/servers");

function mockFile(id) {
  return path.join(SERVERS_BASE, String(id), "mock-players.json");
}

function readMock(id) {
  try {
    const f = mockFile(id);
    if (!fs.existsSync(f)) return null;
    const parsed = JSON.parse(fs.readFileSync(f, "utf8") || "{}");
    if (parsed && Array.isArray(parsed.players)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeMock(id, data) {
  const f = mockFile(id);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
  } catch {
    return;
  }
}

function ensureMock(id) {
  let data = readMock(id);
  if (!data) {
    data = { players: ["Steve", "Alex"], banned: [], ops: [] };
    writeMock(id, data);
  }
  if (!Array.isArray(data.players)) data.players = [];
  if (!Array.isArray(data.banned)) data.banned = [];
  if (!Array.isArray(data.ops)) data.ops = [];
  return data;
}

function getConfig(server) {
  const env = (server && server.env) || {};
  const rc = (server && server.rcon) || {};
  const host = rc.host || env.RCON_HOST || env.RCON_HOSTNAME || null;
  const port = rc.port || env.RCON_PORT ? Number(rc.port || env.RCON_PORT) : null;
  const password = rc.password || env.RCON_PASSWORD || env.RCON_PASS || null;
  if (!host || !password) return null;
  return { host, port: port || 25575, password };
}

function isConfigured(server) {
  return !!getConfig(server);
}

function encodePacket(id, type, body) {
  const payload = Buffer.from(String(body || ""), "utf8");
  const len = 4 + 4 + payload.length + 2;
  const buf = Buffer.alloc(4 + len);
  buf.writeInt32LE(len, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeUInt16LE(0, 12 + payload.length);
  return buf;
}

function sendRconPacket(host, port, password, command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let buffer = Buffer.alloc(0);
    let authed = false;
    const reqId = Math.floor(Math.random() * 100000) + 1;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          socket.destroy();
        } catch {
          return;
        }
        reject(new Error("rcon timeout"));
      }
    }, timeoutMs);

    const done = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        return;
      }
      if (err) reject(err);
      else resolve(result);
    };

    socket.on("error", (err) => done(err));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 12) {
        const len = buffer.readInt32LE(0);
        if (buffer.length < 4 + len) break;
        const packet = buffer.slice(4, 4 + len);
        buffer = buffer.slice(4 + len);
        const pid = packet.readInt32LE(0);
        const ptype = packet.readInt32LE(4);
        const body = packet.slice(8, packet.length - 2).toString("utf8");
        if (!authed) {
          if (pid === -1) {
            done(new Error("rcon auth failed"));
            return;
          }
          authed = true;
          socket.write(encodePacket(reqId, 2, command));
        } else if (pid === reqId && (ptype === 0 || ptype === 2)) {
          done(null, body);
          return;
        }
      }
    });

    socket.connect(port, host, () => {
      socket.write(encodePacket(reqId, 3, password));
    });
  });
}

async function send(server, command) {
  const cmd = String(command || "").trim();
  if (!cmd) throw new Error("command is required");
  const cfg = getConfig(server);
  if (!cfg) {
    return { ok: true, mock: true, response: `[mock] executed: ${cmd}` };
  }
  const response = await sendRconPacket(cfg.host, cfg.port, cfg.password, cmd);
  return { ok: true, mock: false, response };
}

async function listPlayers(server) {
  const cfg = getConfig(server);
  if (!cfg) {
    const data = ensureMock(server.id);
    return { players: data.players, mock: true };
  }
  try {
    const res = await sendRconPacket(cfg.host, cfg.port, cfg.password, "list");
    const names = parseListResponse(res);
    if (names) return { players: names, mock: false, raw: res };
    return { players: [], mock: false, raw: res };
  } catch (err) {
    throw err;
  }
}

function parseListResponse(res) {
  const s = String(res || "");
  const colon = s.indexOf(":");
  if (colon === -1) return null;
  const tail = s.slice(colon + 1).trim();
  if (!tail) return [];
  return tail
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

async function kick(server, player, reason) {
  if (!player) throw new Error("player is required");
  const cfg = getConfig(server);
  if (!cfg) {
    const data = ensureMock(server.id);
    data.players = data.players.filter((p) => p !== player);
    writeMock(server.id, data);
    return { ok: true, mock: true };
  }
  const suffix = reason ? ` ${reason}` : "";
  const r = await send(server, `kick ${player}${suffix}`);
  return { ok: true, mock: r.mock, response: r.response };
}

async function ban(server, player, reason) {
  if (!player) throw new Error("player is required");
  const cfg = getConfig(server);
  if (!cfg) {
    const data = ensureMock(server.id);
    data.players = data.players.filter((p) => p !== player);
    if (!data.banned.includes(player)) data.banned.push(player);
    writeMock(server.id, data);
    return { ok: true, mock: true };
  }
  const suffix = reason ? ` ${reason}` : "";
  const r = await send(server, `ban ${player}${suffix}`);
  return { ok: true, mock: r.mock, response: r.response };
}

async function op(server, player) {
  if (!player) throw new Error("player is required");
  const cfg = getConfig(server);
  if (!cfg) {
    const data = ensureMock(server.id);
    if (!data.ops.includes(player)) data.ops.push(player);
    writeMock(server.id, data);
    return { ok: true, mock: true };
  }
  const r = await send(server, `op ${player}`);
  return { ok: true, mock: r.mock, response: r.response };
}

async function say(server, message) {
  if (!message) throw new Error("message is required");
  const r = await send(server, `say ${message}`);
  return { ok: true, mock: r.mock, response: r.response };
}

module.exports = {
  getConfig,
  isConfigured,
  send,
  listPlayers,
  kick,
  ban,
  op,
  say,
};
