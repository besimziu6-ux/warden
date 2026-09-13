const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { readUsers, writeUsers, toPublic, signToken, requireAuth } = require("../lib/auth");

const router = express.Router();

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;
const rateBuckets = new Map();

function getClientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  if (req.ip) return String(req.ip);
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return "unknown";
}

function authRateLimit(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  let entry = rateBuckets.get(ip);
  if (!entry || now >= entry.reset) {
    entry = { count: 0, reset: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, entry);
    if (rateBuckets.size > 10000) {
      for (const [k, v] of rateBuckets) {
        if (now >= v.reset) rateBuckets.delete(k);
      }
    }
  }
  entry.count += 1;
  if (entry.count > RATE_MAX) {
    const retryAfter = Math.max(1, Math.ceil((entry.reset - now) / 1000));
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "too many requests, try again later" });
  }
  next();
}

function _resetRateLimitForTests() {
  rateBuckets.clear();
}

function validUsername(u) {
  return typeof u === "string" && /^[a-zA-Z0-9_-]{3,32}$/.test(u);
}

function validPassword(p) {
  return typeof p === "string" && p.length >= 8;
}

router.post("/register", authRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: "username must be 3-32 chars [a-zA-Z0-9_-]" });
  if (!validPassword(password))
    return res.status(400).json({ error: "password must be at least 8 chars" });

  const rows = readUsers();
  if (rows.find((u) => u.username === username))
    return res.status(409).json({ error: "username taken" });

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    username,
    passwordHash,
    role: rows.length === 0 ? "admin" : "user",
    createdAt: now,
  };
  rows.push(user);
  writeUsers(rows);
  res.status(201).json({ token: signToken(user), user: toPublic(user) });
});

router.post("/login", authRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  const user = readUsers().find((u) => u.username === username);
  if (!user) return res.status(401).json({ error: "invalid credentials" });
  const ok = await bcrypt.compare(String(password), user.passwordHash);
  if (!ok) return res.status(401).json({ error: "invalid credentials" });
  res.json({ token: signToken(user), user: toPublic(user) });
});

router.get("/me", requireAuth, (req, res) => {
  res.json(req.user);
});

async function listUsers(req, res) {
  const rows = readUsers().map(toPublic);
  res.json(rows);
}

module.exports = router;
module.exports.listUsers = listUsers;
module.exports._resetRateLimitForTests = _resetRateLimitForTests;
