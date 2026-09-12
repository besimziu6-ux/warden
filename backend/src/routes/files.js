const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const store = require("../lib/store");
const { requireAuth } = require("../lib/auth");

const router = express.Router();

const SERVERS_BASE = path.resolve(__dirname, "../../../data/servers");
const MAX_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

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

function serverRoot(id) {
  return path.join(SERVERS_BASE, String(id));
}

function safePath(id, rel) {
  const root = serverRoot(id);
  const relPath = String(rel == null ? "" : rel).replace(/^\/+/, "");
  if (relPath.split("/").some((seg) => seg === "..")) {
    const resolved = path.resolve(root, relPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  }
  const resolved = path.resolve(root, relPath || ".");
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return { root, resolved };
}

function relOf(root, resolved) {
  const rel = path.relative(root, resolved);
  return rel === "" ? "" : rel;
}

function statEntry(root, full) {
  const st = fs.statSync(full);
  return {
    name: path.basename(full),
    path: relOf(root, full),
    type: st.isDirectory() ? "dir" : "file",
    size: st.isDirectory() ? null : st.size,
    mtime: st.mtime.toISOString(),
  };
}

router.use(requireAuth);

router.get("/:id/files", loadServer, (req, res) => {
  const rel = req.query.path || "";
  const jail = safePath(req.server.id, rel);
  if (!jail) return res.status(400).json({ error: "invalid path" });
  try {
    fs.mkdirSync(jail.root, { recursive: true });
    if (!fs.existsSync(jail.resolved)) return res.status(404).json({ error: "not found" });
    const st = fs.statSync(jail.resolved);
    if (!st.isDirectory()) return res.json({ ...statEntry(jail.root, jail.resolved) });
    const names = fs.readdirSync(jail.resolved);
    const entries = names.map((n) => {
      try {
        return statEntry(jail.root, path.join(jail.resolved, n));
      } catch {
        return null;
      }
    }).filter(Boolean);
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ path: relOf(jail.root, jail.resolved), entries });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.get("/:id/files/download", loadServer, (req, res) => {
  const rel = req.query.path || "";
  if (!rel) return res.status(400).json({ error: "path is required" });
  const jail = safePath(req.server.id, rel);
  if (!jail) return res.status(400).json({ error: "invalid path" });
  try {
    if (!fs.existsSync(jail.resolved)) return res.status(404).json({ error: "not found" });
    const st = fs.statSync(jail.resolved);
    if (st.isDirectory()) return res.status(400).json({ error: "path is a directory" });
    res.download(jail.resolved, path.basename(jail.resolved));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.put("/:id/files", loadServer, (req, res) => {
  const rel = req.query.path || (req.body && req.body.path) || "";
  const content = req.body && req.body.content;
  if (!rel) return res.status(400).json({ error: "path is required" });
  if (typeof content !== "string") return res.status(400).json({ error: "content must be a string" });
  const jail = safePath(req.server.id, rel);
  if (!jail) return res.status(400).json({ error: "invalid path" });
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_BYTES) return res.status(413).json({ error: "file too large (20MB max)" });
  try {
    fs.mkdirSync(jail.root, { recursive: true });
    const st = fs.existsSync(jail.resolved) ? fs.statSync(jail.resolved) : null;
    if (st && st.isDirectory()) return res.status(400).json({ error: "path is a directory" });
    fs.mkdirSync(path.dirname(jail.resolved), { recursive: true });
    fs.writeFileSync(jail.resolved, content, "utf8");
    res.json({ ...statEntry(jail.root, jail.resolved) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.post("/:id/files/mkdir", loadServer, (req, res) => {
  const rel = (req.body && req.body.path) || req.query.path || "";
  if (!rel) return res.status(400).json({ error: "path is required" });
  const jail = safePath(req.server.id, rel);
  if (!jail) return res.status(400).json({ error: "invalid path" });
  try {
    fs.mkdirSync(jail.resolved, { recursive: true });
    res.status(201).json({ ...statEntry(jail.root, jail.resolved) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.post("/:id/files/delete", loadServer, (req, res) => {
  const rel = (req.body && req.body.path) || req.query.path || "";
  if (!rel) return res.status(400).json({ error: "path is required" });
  const jail = safePath(req.server.id, rel);
  if (!jail) return res.status(400).json({ error: "invalid path" });
  if (jail.resolved === jail.root) return res.status(400).json({ error: "cannot delete server root" });
  try {
    if (!fs.existsSync(jail.resolved)) return res.status(404).json({ error: "not found" });
    fs.rmSync(jail.resolved, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.post("/:id/files/rename", loadServer, (req, res) => {
  const from = (req.body && (req.body.from || req.body.oldPath || req.body.path)) || req.query.from || "";
  const to = (req.body && (req.body.to || req.body.newPath)) || req.query.to || "";
  if (!from) return res.status(400).json({ error: "from is required" });
  if (!to) return res.status(400).json({ error: "to is required" });
  const src = safePath(req.server.id, from);
  const dst = safePath(req.server.id, to);
  if (!src || !dst) return res.status(400).json({ error: "invalid path" });
  if (src.resolved === src.root || dst.resolved === dst.root)
    return res.status(400).json({ error: "cannot rename server root" });
  try {
    if (!fs.existsSync(src.resolved)) return res.status(404).json({ error: "not found" });
    if (fs.existsSync(dst.resolved)) return res.status(409).json({ error: "destination exists" });
    fs.mkdirSync(path.dirname(dst.resolved), { recursive: true });
    fs.renameSync(src.resolved, dst.resolved);
    res.json({ ...statEntry(dst.root, dst.resolved) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.post("/:id/files/upload", loadServer, (req, res) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE")
        return res.status(413).json({ error: "file too large (20MB max)" });
      return res.status(400).json({ error: String(err.message || err) });
    }
    const dirRel = req.query.path || (req.body && req.body.path) || "";
    const jail = safePath(req.server.id, dirRel);
    if (!jail) return res.status(400).json({ error: "invalid path" });
    if (!req.file) return res.status(400).json({ error: "file is required (field 'file')" });
    if (req.file.size > MAX_BYTES)
      return res.status(413).json({ error: "file too large (20MB max)" });
    try {
      let destDir = jail.resolved;
      if (fs.existsSync(destDir) && fs.statSync(destDir).isFile()) {
        destDir = path.dirname(destDir);
      }
      fs.mkdirSync(destDir, { recursive: true });
      const rawName = req.file.originalname || "upload.bin";
      const base = path.basename(rawName);
      if (!base || base === "." || base === "..")
        return res.status(400).json({ error: "invalid filename" });
      const dest = path.resolve(destDir, base);
      if (dest !== jail.root && !dest.startsWith(jail.root + path.sep))
        return res.status(400).json({ error: "invalid path" });
      fs.writeFileSync(dest, req.file.buffer);
      res.status(201).json({ ...statEntry(jail.root, dest) });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });
});

module.exports = router;
