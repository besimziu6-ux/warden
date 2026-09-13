const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("../lib/store");
const docker = require("../lib/docker");
const { requireAuth } = require("../lib/auth");

const router = express.Router();

const SERVERS_BASE = path.resolve(__dirname, "../../../data/servers");
const ACTIONS = ["start", "stop", "restart", "backup", "command"];

let cron = null;
try {
  cron = require("node-cron");
} catch {
  cron = null;
}

const jobs = new Map();

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

function scheduleFile(id) {
  return path.join(SERVERS_BASE, String(id), "schedules.json");
}

function readSchedules(id) {
  try {
    const f = scheduleFile(id);
    if (!fs.existsSync(f)) return [];
    const parsed = JSON.parse(fs.readFileSync(f, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSchedules(id, rows) {
  const f = scheduleFile(id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(rows, null, 2), "utf8");
}

function jobKey(serverId, scheduleId) {
  return `${serverId}:${scheduleId}`;
}

function stopJob(serverId, scheduleId) {
  const key = jobKey(serverId, scheduleId);
  const job = jobs.get(key);
  if (job) {
    try {
      job.stop();
    } catch {
      return;
    }
    jobs.delete(key);
  }
}

function stopJobsForServer(serverId) {
  for (const key of Array.from(jobs.keys())) {
    if (key.startsWith(`${serverId}:`)) {
      const job = jobs.get(key);
      try {
        if (job) job.stop();
      } catch {
        // fall through to cleanup
      }
      jobs.delete(key);
    }
  }
}

async function runAction(serverId, schedule) {
  const server = store.get(serverId);
  if (!server) return;
  const action = schedule.action;
  try {
    if (action === "start" || action === "stop" || action === "restart") {
      const result = await docker[action](server);
      store.update(server.id, { status: result.status });
    } else if (action === "backup") {
      const backups = require("./backups");
      await backups.createBackup(server, { name: schedule.name || "scheduled" });
    } else if (action === "command") {
      const rcon = require("../lib/rcon");
      const cmd = schedule.payload && schedule.payload.command;
      if (cmd) await rcon.send(server, String(cmd));
    }
  } catch (err) {
    try {
      const f = path.join(SERVERS_BASE, String(serverId), "schedules.log");
      fs.appendFileSync(f, `${new Date().toISOString()} schedule=${schedule.id} error=${err.message || err}\n`, "utf8");
    } catch {
      return;
    }
  }
}

function scheduleOne(serverId, schedule) {
  if (!cron) return false;
  if (!schedule.enabled) return false;
  if (!cron.validate(schedule.cron)) return false;
  stopJob(serverId, schedule.id);
  try {
    const job = cron.schedule(schedule.cron, () => {
      runAction(serverId, schedule);
    });
    jobs.set(jobKey(serverId, schedule.id), job);
    return true;
  } catch {
    return false;
  }
}

function scheduleServer(serverId) {
  stopJobsForServer(serverId);
  const rows = readSchedules(serverId);
  for (const s of rows) scheduleOne(serverId, s);
}

function initSchedules() {
  if (!cron) return { ok: false, reason: "node-cron not installed" };
  try {
    const servers = store.list();
    for (const s of servers) scheduleServer(s.id);
  } catch {
    return { ok: false, reason: "failed to load servers" };
  }
  return { ok: true };
}

router.use(requireAuth);

router.get("/:id/schedules", loadServer, (req, res) => {
  res.json(readSchedules(req.server.id));
});

router.post("/:id/schedules", loadServer, (req, res) => {
  const { name, cron: expr, action, payload, enabled } = req.body || {};
  if (!expr) return res.status(400).json({ error: "cron is required" });
  if (!action) return res.status(400).json({ error: "action is required" });
  if (!ACTIONS.includes(action))
    return res.status(400).json({ error: `action must be one of: ${ACTIONS.join(", ")}` });
  if (cron && !cron.validate(expr)) return res.status(400).json({ error: "invalid cron expression" });
  if (action === "command" && !(payload && payload.command))
    return res.status(400).json({ error: "payload.command is required for command action" });

  const rows = readSchedules(req.server.id);
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: name || action,
    cron: expr,
    action,
    payload: payload || null,
    enabled: enabled !== false,
    createdAt: now,
  };
  rows.push(item);
  try {
    writeSchedules(req.server.id, rows);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
  scheduleOne(req.server.id, item);
  res.status(201).json(item);
});

router.delete("/:id/schedules/:scheduleId", loadServer, (req, res) => {
  const rows = readSchedules(req.server.id);
  const filtered = rows.filter((r) => r.id !== req.params.scheduleId);
  if (filtered.length === rows.length) return res.status(404).json({ error: "not found" });
  try {
    writeSchedules(req.server.id, filtered);
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
  stopJob(req.server.id, req.params.scheduleId);
  res.json({ ok: true });
});

module.exports = router;
module.exports.readSchedules = readSchedules;
module.exports.writeSchedules = writeSchedules;
module.exports.scheduleServer = scheduleServer;
module.exports.initSchedules = initSchedules;
module.exports.runAction = runAction;
module.exports.stopJobsForServer = stopJobsForServer;
