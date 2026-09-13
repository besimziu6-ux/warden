const express = require("express");
const fs = require("fs");
const path = require("path");
const { getEgg } = require("../games/eggs");
const store = require("../lib/store");
const docker = require("../lib/docker");
const { requireAuth } = require("../lib/auth");

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
  } catch (err) {
    server = store.update(server.id, { status: "error", error: String(err.message || err) });
  }
  res.status(201).json(server);
});

router.get("/:id", loadServer, (req, res) => {
  res.json(req.server);
});

async function lifecycle(req, res, action) {
  const server = req.server;
  try {
    const result = await docker[action](server);
    const updated = store.update(server.id, { status: result.status });
    res.json({ ...updated, mock: result.mock });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}

router.post("/:id/start", loadServer, (req, res) => lifecycle(req, res, "start"));
router.post("/:id/stop", loadServer, (req, res) => lifecycle(req, res, "stop"));
router.post("/:id/restart", loadServer, (req, res) => lifecycle(req, res, "restart"));
router.post("/:id/kill", loadServer, (req, res) => lifecycle(req, res, "kill"));

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
