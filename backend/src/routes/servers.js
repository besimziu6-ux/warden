const express = require("express");
const { getEgg } = require("../games/eggs");
const store = require("../lib/store");
const docker = require("../lib/docker");
const { tokenFromHeader, verifyPayload, findById } = require("../lib/auth");

const router = express.Router();

router.get("/", (req, res) => {
  res.json(store.list());
});

router.post("/", async (req, res) => {
  const { game, name, env } = req.body || {};
  if (!game) return res.status(400).json({ error: "game is required" });
  if (!name) return res.status(400).json({ error: "name is required" });
  const egg = getEgg(game);
  if (!egg) return res.status(400).json({ error: `unknown game: ${game}` });

  let server = store.create({
    name,
    game,
    env: { ...egg.env, ...(env || {}) },
    ports: egg.ports,
    image: egg.image,
    status: "created",
    containerId: null,
    ownerId: ownerIdFor(req),
  });

  try {
    const containerId = await docker.createServer(server, egg);
    server = store.update(server.id, { containerId, status: "created" });
  } catch (err) {
    server = store.update(server.id, { status: "error", error: String(err.message || err) });
  }
  res.status(201).json(server);
});

router.get("/:id", (req, res) => {
  const server = store.get(req.params.id);
  if (!server) return res.status(404).json({ error: "not found" });
  res.json(server);
});

function ownerIdFor(req) {
  const token = tokenFromHeader(req);
  if (!token) return null;
  const payload = verifyPayload(token);
  if (!payload) return null;
  const user = findById(payload.sub);
  return user ? user.id : null;
}

async function lifecycle(req, res, action) {
  const server = store.get(req.params.id);
  if (!server) return res.status(404).json({ error: "not found" });
  try {
    const result = await docker[action](server);
    const updated = store.update(server.id, { status: result.status });
    res.json({ ...updated, mock: result.mock });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}

router.post("/:id/start", (req, res) => lifecycle(req, res, "start"));
router.post("/:id/stop", (req, res) => lifecycle(req, res, "stop"));
router.post("/:id/restart", (req, res) => lifecycle(req, res, "restart"));
router.post("/:id/kill", (req, res) => lifecycle(req, res, "kill"));

module.exports = router;
