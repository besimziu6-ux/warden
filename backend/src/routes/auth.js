const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { readUsers, writeUsers, toPublic, signToken, requireAuth } = require("../lib/auth");

const router = express.Router();

function validUsername(u) {
  return typeof u === "string" && /^[a-zA-Z0-9_-]{3,32}$/.test(u);
}

router.post("/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: "username must be 3-32 chars [a-zA-Z0-9_-]" });
  if (typeof password !== "string" || password.length < 6)
    return res.status(400).json({ error: "password must be at least 6 chars" });

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

router.post("/login", async (req, res) => {
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
