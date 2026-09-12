const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = path.resolve(__dirname, "../../../data/servers.json");

function ensureFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]", "utf8");
}

function readAll() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}

function writeAll(rows) {
  ensureFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(rows, null, 2), "utf8");
}

function list() {
  return readAll();
}

function get(id) {
  const rows = readAll();
  return rows.find((r) => r.id === id) || null;
}

function create(data) {
  const rows = readAll();
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    status: "created",
    createdAt: now,
    updatedAt: now,
    ...data,
  };
  rows.push(row);
  writeAll(rows);
  return row;
}

function update(id, patch) {
  const rows = readAll();
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) return null;
  rows[i] = { ...rows[i], ...patch, updatedAt: new Date().toISOString() };
  writeAll(rows);
  return rows[i];
}

function remove(id) {
  const rows = readAll();
  const filtered = rows.filter((r) => r.id !== id);
  if (filtered.length === rows.length) return false;
  writeAll(filtered);
  return true;
}

module.exports = { list, get, create, update, remove, DATA_FILE };
