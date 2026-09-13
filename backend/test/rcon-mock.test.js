"use strict";

process.env.DOCKER_MOCK = "1";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const rcon = require("../src/lib/rcon");

const DATA_DIR = path.resolve(__dirname, "../../data");
const SERVERS_BASE = path.join(DATA_DIR, "servers");
const PREFIX = "test-rcon-";

function mockServer(suffix) {
  return { id: `${PREFIX}${suffix}`, env: {} };
}

function mockFile(id) {
  return path.join(SERVERS_BASE, String(id), "mock-players.json");
}

function cleanupId(id) {
  try {
    fs.rmSync(path.join(SERVERS_BASE, String(id)), { recursive: true, force: true });
  } catch {
    return;
  }
}

function cleanupAll() {
  try {
    if (!fs.existsSync(SERVERS_BASE)) return;
    for (const n of fs.readdirSync(SERVERS_BASE)) {
      if (String(n).startsWith(PREFIX)) {
        try {
          fs.rmSync(path.join(SERVERS_BASE, n), { recursive: true, force: true });
        } catch {
          return;
        }
      }
    }
  } catch {
    return;
  }
}

describe("rcon mock flows", () => {
  before(() => {
    cleanupAll();
  });

  after(() => {
    cleanupAll();
  });

  it("reports unconfigured mock servers via getConfig/isConfigured", () => {
    const srv = mockServer("cfg");
    try {
      assert.equal(rcon.getConfig(srv), null);
      assert.equal(rcon.isConfigured(srv), false);
      assert.equal(rcon.getConfig({ id: "x", env: { RCON_HOST: "h" } }), null);
      const cfg = rcon.getConfig({
        id: "x",
        env: { RCON_HOST: "h", RCON_PASSWORD: "p", RCON_PORT: "25575" },
      });
      assert.equal(cfg.host, "h");
      assert.equal(cfg.password, "p");
    } finally {
      cleanupId(srv.id);
    }
  });

  it("lists default mock players", async () => {
    const srv = mockServer("list");
    try {
      const r = await rcon.listPlayers(srv);
      assert.equal(r.mock, true);
      assert.deepEqual(r.players, ["Steve", "Alex"]);
    } finally {
      cleanupId(srv.id);
    }
  });

  it("send returns mock response and requires a command", async () => {
    const srv = mockServer("send");
    try {
      const r = await rcon.send(srv, "list");
      assert.equal(r.ok, true);
      assert.equal(r.mock, true);
      assert.match(r.response, /\[mock\] executed: list/);
      await assert.rejects(() => rcon.send(srv, ""), /command is required/);
      await assert.rejects(() => rcon.send(srv, "   "), /command is required/);
    } finally {
      cleanupId(srv.id);
    }
  });

  it("kick removes the player in mock mode", async () => {
    const srv = mockServer("kick");
    try {
      let r = await rcon.listPlayers(srv);
      assert.ok(r.players.includes("Steve"));
      const k = await rcon.kick(srv, "Steve");
      assert.deepEqual(k, { ok: true, mock: true });
      r = await rcon.listPlayers(srv);
      assert.equal(r.players.includes("Steve"), false);
      assert.ok(r.players.includes("Alex"));
      await assert.rejects(() => rcon.kick(srv, ""), /player is required/);
    } finally {
      cleanupId(srv.id);
    }
  });

  it("ban removes from players and records banned", async () => {
    const srv = mockServer("ban");
    try {
      const b = await rcon.ban(srv, "Alex", "griefing");
      assert.equal(b.ok, true);
      assert.equal(b.mock, true);
      const data = JSON.parse(fs.readFileSync(mockFile(srv.id), "utf8"));
      assert.equal(data.players.includes("Alex"), false);
      assert.ok(data.banned.includes("Alex"));
      await assert.rejects(() => rcon.ban(srv, ""), /player is required/);
    } finally {
      cleanupId(srv.id);
    }
  });

  it("op adds to ops idempotently", async () => {
    const srv = mockServer("op");
    try {
      const o1 = await rcon.op(srv, "Steve");
      assert.deepEqual(o1, { ok: true, mock: true });
      const o2 = await rcon.op(srv, "Steve");
      assert.deepEqual(o2, { ok: true, mock: true });
      const data = JSON.parse(fs.readFileSync(mockFile(srv.id), "utf8"));
      assert.deepEqual(data.ops.filter((p) => p === "Steve").length, 1);
      await assert.rejects(() => rcon.op(srv, ""), /player is required/);
    } finally {
      cleanupId(srv.id);
    }
  });

  it("say returns mock response and requires a message", async () => {
    const srv = mockServer("say");
    try {
      const r = await rcon.say(srv, "hello world");
      assert.equal(r.ok, true);
      assert.equal(r.mock, true);
      assert.match(r.response, /say hello world/);
      await assert.rejects(() => rcon.say(srv, ""), /message is required/);
    } finally {
      cleanupId(srv.id);
    }
  });

  it("keeps mock state isolated per server", async () => {
    const a = mockServer("iso-a");
    const b = mockServer("iso-b");
    try {
      await rcon.kick(a, "Steve");
      const ra = await rcon.listPlayers(a);
      const rb = await rcon.listPlayers(b);
      assert.equal(ra.players.includes("Steve"), false);
      assert.ok(rb.players.includes("Steve"));
    } finally {
      cleanupId(a.id);
      cleanupId(b.id);
    }
  });
});
