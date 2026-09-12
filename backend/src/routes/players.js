const express = require("express");
const store = require("../lib/store");
const { requireAuth } = require("../lib/auth");
const rcon = require("../lib/rcon");

const router = express.Router();

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

router.use(requireAuth);

router.get("/:id/players", loadServer, async (req, res) => {
  try {
    const result = await rcon.listPlayers(req.server);
    res.json({ players: result.players, mock: result.mock, ...(result.raw ? { raw: result.raw } : {}) });
  } catch (err) {
    res.status(502).json({ error: `rcon failed: ${err.message || err}` });
  }
});

router.post("/:id/players/kick", loadServer, async (req, res) => {
  const { player, reason } = req.body || {};
  if (!player) return res.status(400).json({ error: "player is required" });
  try {
    const r = await rcon.kick(req.server, String(player), reason ? String(reason) : undefined);
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: `rcon failed: ${err.message || err}` });
  }
});

router.post("/:id/players/ban", loadServer, async (req, res) => {
  const { player, reason } = req.body || {};
  if (!player) return res.status(400).json({ error: "player is required" });
  try {
    const r = await rcon.ban(req.server, String(player), reason ? String(reason) : undefined);
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: `rcon failed: ${err.message || err}` });
  }
});

router.post("/:id/players/op", loadServer, async (req, res) => {
  const { player } = req.body || {};
  if (!player) return res.status(400).json({ error: "player is required" });
  try {
    const r = await rcon.op(req.server, String(player));
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: `rcon failed: ${err.message || err}` });
  }
});

router.post("/:id/players/say", loadServer, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: "message is required" });
  try {
    const r = await rcon.say(req.server, String(message));
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: `rcon failed: ${err.message || err}` });
  }
});

router.post("/:id/players/command", loadServer, async (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: "command is required" });
  try {
    const r = await rcon.send(req.server, String(command));
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: `rcon failed: ${err.message || err}` });
  }
});

module.exports = router;
