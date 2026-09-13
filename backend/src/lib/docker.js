const path = require("path");
const fs = require("fs");

let Docker;
try {
  Docker = require("dockerode");
} catch {
  Docker = null;
}

let client = null;
let mock = true;
let checked = false;
const states = new Map();

// Isolation defaults applied to every game container.
// Keeps one misbehaving server from taking down the host.
const DEFAULT_LIMITS = {
  Memory: 2 * 1024 * 1024 * 1024,
  MemorySwap: 2 * 1024 * 1024 * 1024,
  NanoCpus: 2 * 1000 * 1000 * 1000,
  PidsLimit: 256,
  User: "1000:1000",
};

// Floor values that would produce a broken or rejected container config.
const MIN_LIMITS = {
  Memory: 128 * 1024 * 1024,
  NanoCpus: 50 * 1000 * 1000,
  PidsLimit: 32,
};

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function dataRoot() {
  return process.env.DATA_ROOT || path.resolve(__dirname, "../../../data");
}

function limitsFor(server) {
  const over = (server && server.limits) || {};

  const memory = Math.max(
    Math.floor(toFiniteNumber(over.Memory ?? over.memory ?? DEFAULT_LIMITS.Memory, DEFAULT_LIMITS.Memory)),
    MIN_LIMITS.Memory
  );

  // Docker rejects a container whose swap limit sits below its memory limit.
  let memorySwap = Math.floor(
    toFiniteNumber(over.MemorySwap ?? over.memorySwap ?? DEFAULT_LIMITS.MemorySwap, DEFAULT_LIMITS.MemorySwap)
  );
  if (memorySwap < memory) memorySwap = memory;

  // Each branch resolved on its own so an unrelated override (e.g. only
  // Memory) cannot drag NanoCpus into the computed path.
  const nanoExplicit = over.NanoCpus ?? over.nanoCpus;
  const cpusExplicit = over.cpus ?? over.Cpus;
  let nanoRaw;
  if (nanoExplicit !== undefined) {
    nanoRaw = toFiniteNumber(nanoExplicit, DEFAULT_LIMITS.NanoCpus);
  } else if (cpusExplicit !== undefined) {
    const cpus = toFiniteNumber(cpusExplicit, NaN);
    nanoRaw = Number.isFinite(cpus) ? cpus * 1e9 : DEFAULT_LIMITS.NanoCpus;
  } else {
    nanoRaw = DEFAULT_LIMITS.NanoCpus;
  }
  const nanoCpus = Math.max(Math.floor(nanoRaw), MIN_LIMITS.NanoCpus);

  const pidsLimit = Math.max(
    Math.floor(
      toFiniteNumber(over.PidsLimit ?? over.pidsLimit ?? over.pids ?? DEFAULT_LIMITS.PidsLimit, DEFAULT_LIMITS.PidsLimit)
    ),
    MIN_LIMITS.PidsLimit
  );

  return {
    Memory: memory,
    MemorySwap: memorySwap,
    NanoCpus: nanoCpus,
    PidsLimit: pidsLimit,
    User: over.User || over.user || DEFAULT_LIMITS.User,
  };
}

async function check() {
  if (process.env.DOCKER_MOCK === "1") {
    mock = true;
    checked = true;
    client = null;
    return false;
  }
  if (checked) return !mock;
  checked = true;
  if (!Docker) {
    mock = true;
    return false;
  }
  try {
    client = new Docker();
    await client.ping();
    mock = false;
    return true;
  } catch {
    client = null;
    mock = true;
    return false;
  }
}

function isMock() {
  return mock;
}

function mockId(server) {
  return `mock-${server.id}`;
}

function getMockState(server) {
  return states.get(server.id) || server.status || "created";
}

async function getContainer(server) {
  if (mock || !client) return null;
  const cid = server.containerId;
  if (!cid) return null;
  try {
    return client.getContainer(cid);
  } catch {
    return null;
  }
}

async function createServer(server, egg) {
  await check();
  if (mock || !client) {
    states.set(server.id, "created");
    return mockId(server);
  }
  const env = Object.entries(server.env || {}).map(([k, v]) => `${k}=${v}`);
  const exposed = {};
  const bindings = {};
  for (const p of egg.ports || []) {
    const key = `${p.container}/${p.protocol || "tcp"}`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: "" }];
  }
  const limits = limitsFor(server);
  const serverDir = path.join(dataRoot(), "servers", server.id);
  try {
    fs.mkdirSync(serverDir, { recursive: true });
  } catch {
    // best effort; daemon bind still attempted below
  }
  const container = await client.createContainer({
    Image: egg.image,
    name: `panel-${server.id.slice(0, 12)}`,
    Env: env,
    User: limits.User,
    ExposedPorts: exposed,
    HostConfig: {
      PortBindings: bindings,
      AutoRemove: false,
      Privileged: false,
      Memory: limits.Memory,
      MemorySwap: limits.MemorySwap,
      NanoCpus: limits.NanoCpus,
      PidsLimit: limits.PidsLimit,
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "SETUID", "SETGID"],
      SecurityOpt: ["no-new-privileges:true"],
      Binds: [`${serverDir}:/data:rw`],
    },
  });
  states.set(server.id, "created");
  return container.id;
}

async function start(server) {
  await check();
  if (mock || !client) {
    states.set(server.id, "running");
    return { status: "running", mock: true };
  }
  const c = await getContainer(server);
  if (!c) throw new Error("container not found");
  await c.start();
  states.set(server.id, "running");
  return { status: "running", mock: false };
}

async function stop(server) {
  await check();
  if (mock || !client) {
    states.set(server.id, "stopped");
    return { status: "stopped", mock: true };
  }
  const c = await getContainer(server);
  if (!c) throw new Error("container not found");
  try {
    await c.stop({ t: 10 });
  } catch (err) {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  }
  states.set(server.id, "stopped");
  return { status: "stopped", mock: false };
}

async function restart(server) {
  await check();
  if (mock || !client) {
    states.set(server.id, "running");
    return { status: "running", mock: true };
  }
  const c = await getContainer(server);
  if (!c) throw new Error("container not found");
  try {
    await c.restart({ t: 10 });
  } catch {
    await c.start();
  }
  states.set(server.id, "running");
  return { status: "running", mock: false };
}

async function kill(server) {
  await check();
  if (mock || !client) {
    states.set(server.id, "killed");
    return { status: "killed", mock: true };
  }
  const c = await getContainer(server);
  if (!c) throw new Error("container not found");
  try {
    await c.kill();
  } catch (err) {
    if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
  }
  states.set(server.id, "killed");
  return { status: "killed", mock: false };
}

async function removeServer(server) {
  await check();
  if (mock || !client) {
    states.delete(server.id);
    return { status: "removed", mock: true };
  }
  const c = await getContainer(server);
  if (c) {
    try {
      await c.stop({ t: 10 });
    } catch (err) {
      if (err.statusCode !== 304 && err.statusCode !== 404) throw err;
    }
    try {
      await c.remove({ force: true });
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }
  states.delete(server.id);
  return { status: "removed", mock: false };
}

async function inspectStatus(server) {
  await check();
  if (mock || !client) return getMockState(server);
  const c = await getContainer(server);
  if (!c) return server.status || "created";
  try {
    const info = await c.inspect();
    if (info.State.Running) return "running";
    if (info.State.Paused) return "paused";
    return "stopped";
  } catch {
    return server.status || "created";
  }
}

module.exports = {
  check,
  isMock,
  createServer,
  start,
  stop,
  restart,
  kill,
  removeServer,
  inspectStatus,
  DEFAULT_LIMITS,
  MIN_LIMITS,
  limitsFor,
  getMockState,
  _resetForTests() {
    states.clear();
    checked = false;
    mock = true;
    client = null;
  },
};
