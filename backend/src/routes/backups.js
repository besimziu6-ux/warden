const express = require("express");
const fs = require("fs");
const path = require("path");
const store = require("../lib/store");
const { requireAuth } = require("../lib/auth");

const router = express.Router();

const SERVERS_BASE = path.resolve(__dirname, "../../../data/servers");
const BACKUPS_BASE = path.resolve(__dirname, "../../../data/backups");

let tar = null;
try {
  tar = require("tar");
} catch {
  tar = null;
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

function loadServer(req, res, next) {
  const server = store.get(req.params.id);
  if (!server) return res.status(404).json({ error: "not found" });
  if (!canAccess(req.user, server)) return res.status(403).json({ error: "forbidden" });
  req.server = server;
  next();
}

function backupDir(id) {
  return path.join(BACKUPS_BASE, String(id));
}

function serverRoot(id) {
  return path.join(SERVERS_BASE, String(id));
}

function safeBackupName(name) {
  const base = path.basename(String(name || ""));
  if (!base || base === "." || base === "..") return null;
  if (base.includes("\0")) return null;
  if (!base.endsWith(".tgz") && !base.endsWith(".tar.gz")) return null;
  if (base.includes("/") || base.includes("\\")) return null;
  return base;
}

function listBackups(id) {
  const dir = backupDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".tgz") || n.endsWith(".tar.gz"))
    .map((n) => {
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) return null;
        return { id: n, name: n, file: n, size: st.size, createdAt: st.mtime.toISOString() };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function createBackup(server, opts) {
  if (!tar) throw new Error("tar package not installed");
  const id = server.id;
  const root = serverRoot(id);
  fs.mkdirSync(root, { recursive: true });
  const dir = backupDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const label = opts && opts.name ? String(opts.name).replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 40) : "backup";
  const file = `${stamp}-${label}.tgz`;
  const dest = path.join(dir, file);
  await tar.c({ gzip: true, file: dest, cwd: root }, ["."]);
  const st = fs.statSync(dest);
  return { id: file, name: file, file, size: st.size, createdAt: st.mtime.toISOString() };
}

async function restoreBackup(server, backupId) {
  if (!tar) throw new Error("tar package not installed");
  const name = safeBackupName(backupId);
  if (!name) throw new Error("invalid backup id");
  const src = path.join(backupDir(server.id), name);
  if (!fs.existsSync(src)) {
    const err = new Error("backup not found");
    err.status = 404;
    throw err;
  }
  const root = serverRoot(server.id);
  fs.mkdirSync(root, { recursive: true });
  await tar.x({ file: src, C: root });
  return { ok: true, restored: name };
}

router.use(requireAuth);

router.get("/:id/backups", loadServer, (req, res) => {
  try {
    res.json(listBackups(req.server.id));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.post("/:id/backups", loadServer, async (req, res) => {
  try {
    const item = await createBackup(req.server, req.body || {});
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.post("/:id/backups/:backupId/restore", loadServer, async (req, res) => {
  try {
    const r = await restoreBackup(req.server, req.params.backupId);
    res.json(r);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ error: String(err.message || err) });
  }
});

router.delete("/:id/backups/:backupId", loadServer, (req, res) => {
  const name = safeBackupName(req.params.backupId);
  if (!name) return res.status(400).json({ error: "invalid backup id" });
  const full = path.join(backupDir(req.server.id), name);
  if (!full.startsWith(backupDir(req.server.id) + path.sep) && full !== path.join(backupDir(req.server.id), name))
    return res.status(400).json({ error: "invalid backup id" });
  try {
    if (!fs.existsSync(full)) return res.status(404).json({ error: "not found" });
    fs.rmSync(full, { force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
module.exports.createBackup = createBackup;
module.exports.restoreBackup = restoreBackup;
module.exports.listBackups = listBackups;
