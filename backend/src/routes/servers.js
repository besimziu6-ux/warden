const express = require("express");
const fs = require("fs");
const path = require("path");
const { getEgg } = require("../games/eggs");
const store = require("../lib/store");
const docker = require("../lib/docker");
const { requireAuth } = require("../lib/auth");
const { emitLine } = require("./console");

const router = express.Router();

const SERVERS_BASE = path.resolve(__dirname, "../../../data/servers");
const BACKUPS_BASE = path.resolve(__dirname, "../../../data/backups");

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

function loadServer(req, res, next) {
  const server = store.get(req.params.id);
  if (!server) return res.status(404).json({ error: "not found" });
  if (!canAccess(req.user, server)) return res.status(403).json({ error: "forbidden" });
  req.server = server;
  next();
}

function validateEnv(env) {
  if (env === undefined) return true;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return false;
  return Object.values(env).every((v) => typeof v === "string");
}

router.use(requireAuth);

router.get("/", (req, res) => {
  const all = store.list();
  if (req.user.role === "admin") return res.json(all);
  res.json(all.filter((s) => canAccess(req.user, s)));
});

router.post("/", async (req, res) => {
  const { game, name, env } = req.body || {};
  if (!game) return res.status(400).json({ error: "game is required" });
  if (typeof name !== "string" || !name.trim())
    return res.status(400).json({ error: "name is required" });
  if (name.trim().length > 100)
    return res.status(400).json({ error: "name must be at most 100 characters" });
  if (!validateEnv(env))
    return res.status(400).json({ error: "env must be an object of string values" });
  const egg = getEgg(game);
  if (!egg) return res.status(400).json({ error: `unknown game: ${game}` });

  let server = store.create({
    name: name.trim(),
    game,
    env: { ...egg.env, ...(env || {}) },
    ports: egg.ports,
    image: egg.image,
    status: "created",
    containerId: null,
    ownerId: req.user.id,
  });

  try {
    const containerId = await docker.createServer(server, egg);
    server = store.update(server.id, { containerId, status: "created" });
    emitLine(server.id, `[warden] server created from egg ${game} (${egg.image})`);
  } catch (err) {
    server = store.update(server.id, { status: "error", error: String(err.message || err) });
    emitLine(server.id, `[warden] create failed: ${String(err.message || err)}`);
  }
  res.status(201).json(server);
});

router.get("/:id", loadServer, (req, res) => {
  res.json(req.server);
});

async function lifecycle(req, res, action) {
  const server = req.server;
  emitLine(server.id, `[warden] ${action} requested by ${req.user.username}...`);
  try {
    const result = await docker[action](server);
    const updated = store.update(server.id, { status: result.status });
    if (action === "start" && result.mock) {
      const egg = getEgg(server.game);
      if (egg && egg.startup) emitLine(server.id, `[mock] executing startup: ${egg.startup}`);
    }
    emitLine(
      server.id,
      result.mock
        ? `[warden] server is now ${result.status} (mock driver, no container attached)`
        : `[warden] server is now ${result.status}`
    );
    res.json({ ...updated, mock: result.mock });
  } catch (err) {
    emitLine(server.id, `[warden] ${action} failed: ${String(err.message || err)}`);
    res.status(500).json({ error: String(err.message || err) });
  }
}

function hashStr(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function mockStats(server, limits) {
  if ((server.status || "created") !== "running") {
    return { cpuPct: 0, memUsed: 0, memLimit: limits.Memory, cpuLimit: limits.NanoCpus / 1e9, mock: true };
  }
  const t = Date.now() / 8000;
  const h = hashStr(server.id);
  const memFrac = 0.3 + 0.1 * Math.sin(t + h) + 0.05 * Math.sin(t * 2.3 + h * 2);
  const cpuFrac = 0.2 + 0.12 * Math.sin(t * 1.3 + h) + 0.06 * Math.sin(t * 3.1 + h * 3);
  return {
    cpuPct: Math.max(1, cpuFrac * 100),
    memUsed: Math.floor(limits.Memory * Math.min(0.92, Math.max(0.05, memFrac))),
    memLimit: limits.Memory,
    cpuLimit: limits.NanoCpus / 1e9,
    mock: true,
  };
}

router.post("/:id/start", loadServer, (req, res) => lifecycle(req, res, "start"));
router.post("/:id/stop", loadServer, (req, res) => lifecycle(req, res, "stop"));
router.post("/:id/restart", loadServer, (req, res) => lifecycle(req, res, "restart"));
router.post("/:id/kill", loadServer, (req, res) => lifecycle(req, res, "kill"));

router.get("/:id/stats", loadServer, async (req, res) => {
  const limits = docker.limitsFor(req.server);
  try {
    const live = await docker.statsSample(req.server);
    if (live) {
      return res.json({
        status: req.server.status,
        cpuPct: live.cpuPct,
        memUsed: live.memUsed,
        memLimit: limits.Memory,
        cpuLimit: limits.NanoCpus / 1e9,
        mock: false,
      });
    }
  } catch {
    return res.status(502).json({ error: "stats unavailable" });
  }
  res.json({ status: req.server.status, ...mockStats(req.server, limits) });
});

router.delete("/:id", loadServer, async (req, res) => {
  const id = req.server.id;
  try {
    await docker.removeServer(req.server);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
  try {
    require("./schedules").stopJobsForServer(id);
  } catch {
    // no cron jobs to stop
  }
  try {
    fs.rmSync(path.join(SERVERS_BASE, String(id)), { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
  try {
    fs.rmSync(path.join(BACKUPS_BASE, String(id)), { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
  store.remove(id);
  res.json({ ok: true });
});

module.exports = router;
