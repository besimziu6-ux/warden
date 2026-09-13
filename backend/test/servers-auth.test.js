"use strict";

process.env.DOCKER_MOCK = "1";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const express = require("express");

const auth = require("../src/lib/auth");
const store = require("../src/lib/store");
const docker = require("../src/lib/docker");
const serversRouter = require("../src/routes/servers");

const USERS_FILE = auth.USERS_FILE;
const SERVERS_FILE = store.DATA_FILE;

const alice = { id: "u-alice", username: "alice", role: "user", createdAt: "2026-01-01" };
const bob = { id: "u-bob", username: "bob", role: "user", createdAt: "2026-01-01" };
const admin = { id: "u-admin", username: "root", role: "admin", createdAt: "2026-01-01" };

let app;
let httpServer;
let base;
let usersBackup = null;
let serversBackup = null;
let tokenAlice;
let tokenBob;
let tokenAdmin;

function writeServers(rows) {
  fs.mkdirSync(require("path").dirname(SERVERS_FILE), { recursive: true });
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(rows, null, 2), "utf8");
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + path, {
    method: opts.method || "GET",
    headers,
    body,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const withToken = (token) => ({ Authorization: `Bearer ${token}` });

describe("servers auth and ownership", () => {
  before(async () => {
    try {
      usersBackup = fs.existsSync(USERS_FILE) ? fs.readFileSync(USERS_FILE, "utf8") : null;
    } catch {
      usersBackup = null;
    }
    try {
      serversBackup = fs.existsSync(SERVERS_FILE) ? fs.readFileSync(SERVERS_FILE, "utf8") : null;
    } catch {
      serversBackup = null;
    }

    auth.writeUsers([alice, bob, admin]);
    tokenAlice = auth.signToken(alice);
    tokenBob = auth.signToken(bob);
    tokenAdmin = auth.signToken(admin);

    app = express();
    app.use(express.json());
    app.use("/api/servers", serversRouter);
    await new Promise((resolve) => {
      httpServer = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    if (usersBackup === null) {
      try {
        fs.rmSync(USERS_FILE);
      } catch {
        // ignore
      }
    } else {
      fs.writeFileSync(USERS_FILE, usersBackup, "utf8");
    }
    if (serversBackup === null) {
      try {
        fs.rmSync(SERVERS_FILE);
      } catch {
        // ignore
      }
    } else {
      fs.writeFileSync(SERVERS_FILE, serversBackup, "utf8");
    }
  });

  beforeEach(() => {
    docker._resetForTests();
    writeServers([]);
  });

  it("returns 401 for unauthenticated GET/POST/lifecycle", async () => {
    const owned = store.create({
      name: "seed",
      game: "minecraft-java",
      env: {},
      status: "created",
      ownerId: bob.id,
    });

    let r = await api("/api/servers");
    assert.equal(r.status, 401);

    r = await api("/api/servers", { method: "POST", body: { game: "minecraft-java", name: "x" } });
    assert.equal(r.status, 401);

    r = await api(`/api/servers/${owned.id}`);
    assert.equal(r.status, 401);

    for (const act of ["start", "stop", "restart", "kill"]) {
      r = await api(`/api/servers/${owned.id}/${act}`, { method: "POST" });
      assert.equal(r.status, 401);
    }
  });

  it("user A cannot read or control user B's server (403)", async () => {
    const owned = store.create({
      name: "bob-box",
      game: "minecraft-java",
      env: {},
      status: "created",
      ownerId: bob.id,
    });

    let r = await api(`/api/servers/${owned.id}`, { headers: withToken(tokenAlice) });
    assert.equal(r.status, 403);

    for (const act of ["start", "stop", "restart", "kill"]) {
      r = await api(`/api/servers/${owned.id}/${act}`, {
        method: "POST",
        headers: withToken(tokenAlice),
      });
      assert.equal(r.status, 403);
    }
  });

  it("owner can read and control own server", async () => {
    const owned = store.create({
      name: "bob-box",
      game: "minecraft-java",
      env: {},
      status: "created",
      ownerId: bob.id,
    });

    let r = await api(`/api/servers/${owned.id}`, { headers: withToken(tokenBob) });
    assert.equal(r.status, 200);
    assert.equal(r.json.id, owned.id);

    r = await api(`/api/servers/${owned.id}/start`, {
      method: "POST",
      headers: withToken(tokenBob),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "running");
  });

  it("admin can read and control any server", async () => {
    const owned = store.create({
      name: "bob-box",
      game: "minecraft-java",
      env: {},
      status: "created",
      ownerId: bob.id,
    });

    let r = await api(`/api/servers/${owned.id}`, { headers: withToken(tokenAdmin) });
    assert.equal(r.status, 200);
    assert.equal(r.json.id, owned.id);

    r = await api(`/api/servers/${owned.id}/start`, {
      method: "POST",
      headers: withToken(tokenAdmin),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "running");
  });

  it("list is scoped to caller for non-admins, full for admin", async () => {
    const a = store.create({ name: "a", game: "cs2", env: {}, status: "created", ownerId: alice.id });
    const b = store.create({ name: "b", game: "cs2", env: {}, status: "created", ownerId: bob.id });

    let r = await api("/api/servers", { headers: withToken(tokenAlice) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((s) => s.id).sort(), [a.id]);

    r = await api("/api/servers", { headers: withToken(tokenBob) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((s) => s.id).sort(), [b.id]);

    r = await api("/api/servers", { headers: withToken(tokenAdmin) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.map((s) => s.id).sort(), [a.id, b.id].sort());
  });

  it("create sets ownerId from JWT and validates name/env", async () => {
    let r = await api("/api/servers", {
      method: "POST",
      headers: withToken(tokenAlice),
      body: { game: "minecraft-java", name: "  my server  ", env: { FOO: "bar" } },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.ownerId, alice.id);
    assert.equal(r.json.name, "my server");
    assert.equal(r.json.env.FOO, "bar");

    r = await api("/api/servers", {
      method: "POST",
      headers: withToken(tokenAlice),
      body: { game: "minecraft-java", name: "   " },
    });
    assert.equal(r.status, 400);

    r = await api("/api/servers", {
      method: "POST",
      headers: withToken(tokenAlice),
      body: { game: "minecraft-java", name: "x".repeat(101) },
    });
    assert.equal(r.status, 400);

    r = await api("/api/servers", {
      method: "POST",
      headers: withToken(tokenAlice),
      body: { game: "minecraft-java", name: "ok", env: { FOO: 123 } },
    });
    assert.equal(r.status, 400);

    r = await api("/api/servers", {
      method: "POST",
      headers: withToken(tokenAlice),
      body: { game: "minecraft-java", name: "ok", env: ["FOO"] },
    });
    assert.equal(r.status, 400);
  });
});
