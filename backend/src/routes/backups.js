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

const MAX_BACKUPS_PER_SERVER = 10;

function isUnsafeTarEntry(p) {
  if (!p) return true;
  const s = String(p);
  if (path.isAbsolute(s)) return true;
  const parts = s.split(/[\\/]+/);
  if (parts.includes("..")) return true;
  return false;
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

function pruneBackups(id) {
  const items = listBackups(id);
  if (items.length <= MAX_BACKUPS_PER_SERVER) return [];
  const asc = [...items].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
  const excess = items.length - MAX_BACKUPS_PER_SERVER;
  const pruned = [];
  for (let i = 0; i < excess; i++) {
    try {
      fs.rmSync(path.join(backupDir(id), asc[i].file), { force: true });
      pruned.push(asc[i].file);
    } catch {
      /* noop */
    }
  }
  return pruned;
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
  let file = `${stamp}-${label}.tgz`;
  let dest = path.join(dir, file);
  for (let n = 1; n < 1000 && fs.existsSync(dest); n++) {
    file = `${stamp}-${label}-${n}.tgz`;
    dest = path.join(dir, file);
  }
  await tar.c({ gzip: true, file: dest, cwd: root }, ["."]);
  const pruned = pruneBackups(id);
  const st = fs.statSync(dest);
  const count = listBackups(id).length;
  return { id: file, name: file, file, size: st.size, createdAt: st.mtime.toISOString(), count, pruned };
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
  let skipped = 0;
  await tar.x({
    file: src,
    C: root,
    filter: (p) => {
      if (isUnsafeTarEntry(p)) {
        skipped++;
        return false;
      }
      return true;
    },
  });
  return { ok: true, restored: name, skipped };
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

router.get("/:id/backups/:backupId/download", loadServer, (req, res) => {
  const name = safeBackupName(req.params.backupId);
  if (!name) return res.status(400).json({ error: "invalid backup id" });
  const full = path.join(backupDir(req.server.id), name);
  try {
    if (!fs.existsSync(full)) return res.status(404).json({ error: "not found" });
    const st = fs.statSync(full);
    if (!st.isFile()) return res.status(404).json({ error: "not found" });
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", 'attachment; filename="' + name + '"');
    res.setHeader("Content-Length", String(st.size));
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
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
module.exports.pruneBackups = pruneBackups;
module.exports.isUnsafeTarEntry = isUnsafeTarEntry;
module.exports.MAX_BACKUPS_PER_SERVER = MAX_BACKUPS_PER_SERVER;
