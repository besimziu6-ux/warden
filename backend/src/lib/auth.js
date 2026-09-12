const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const USERS_FILE = path.resolve(__dirname, "../../../data/users.json");
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";

function ensureFile() {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf8");
}

function readUsers() {
  ensureFile();
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function writeUsers(rows) {
  ensureFile();
  fs.writeFileSync(USERS_FILE, JSON.stringify(rows, null, 2), "utf8");
}

function toPublic(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt };
}

function findByUsername(username) {
  return readUsers().find((u) => u.username === username) || null;
}

function findById(id) {
  return readUsers().find((u) => u.id === id) || null;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyPayload(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function tokenFromHeader(req) {
  const h = req.headers && req.headers.authorization;
  if (!h) return null;
  const parts = String(h).split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return parts[1] || null;
}

function requireAuth(req, res, next) {
  const token = tokenFromHeader(req);
  if (!token) return res.status(401).json({ error: "missing token" });
  const payload = verifyPayload(token);
  if (!payload) return res.status(401).json({ error: "invalid token" });
  const user = findById(payload.sub);
  if (!user) return res.status(401).json({ error: "unknown user" });
  req.user = toPublic(user);
  req.auth = payload;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "unauthorized" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "forbidden" });
  next();
}

module.exports = {
  USERS_FILE,
  readUsers,
  writeUsers,
  findByUsername,
  findById,
  toPublic,
  signToken,
  verifyPayload,
  tokenFromHeader,
  requireAuth,
  requireAdmin,
};
