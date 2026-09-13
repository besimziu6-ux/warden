"use strict";

process.env.DOCKER_MOCK = "1";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");

const auth = require("../src/lib/auth");
const store = require("../src/lib/store");

const PREFIX = "test-sched-";
const admin = { id: "u-test-sched-admin", username: "sched-admin", role: "admin", createdAt: "2026-01-01" };

const memServers = new Map();
store.list = () => Array.from(memServers.values());
store.get = (id) => memServers.get(String(id)) || null;
store.create = (data) => {
  const now = new Date().toISOString();
  const row = {
    id: (data && data.id) || `${PREFIX}${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
    status: "created",
    createdAt: now,
    updatedAt: now,
    ...data,
  };
  memServers.set(String(row.id), row);
  return row;
};
store.remove = (id) => memServers.delete(String(id));
store.update = (id, patch) => {
  const cur = memServers.get(String(id));
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  memServers.set(String(id), next);
  return next;
};
auth.requireAuth = (req, _res, next) => {
  req.user = { id: admin.id, username: admin.username, role: admin.role, createdAt: admin.createdAt };
  next();
};

const schedulesRouter = require("../src/routes/schedules");
const { readSchedules, writeSchedules, stopJobsForServer } = require("../src/routes/schedules");

const DATA_DIR = path.resolve(__dirname, "../../data");
const SERVERS_BASE = path.join(DATA_DIR, "servers");

let app;
let httpServer;
let base;
let seq = 0;

function makeServer() {
  seq += 1;
  const id = `${PREFIX}${process.pid}-${Date.now()}-${seq}`;
  const srv = store.create({
    id,
    name: `${PREFIX}srv-${seq}`,
    game: "minecraft-java",
    env: {},
    status: "created",
    ownerId: admin.id,
  });
  return srv;
}

function cleanupServer(srv) {
  if (!srv) return;
  try {
    stopJobsForServer(srv.id);
  } catch {
    return;
  }
  try {
    memServers.delete(String(srv.id));
  } catch {
    return;
  }
  try {
    fs.rmSync(path.join(SERVERS_BASE, String(srv.id)), { recursive: true, force: true });
  } catch {
    return;
  }
}

function cleanupAll() {
  for (const id of Array.from(memServers.keys())) {
    if (String(id).startsWith(PREFIX)) {
      try {
        stopJobsForServer(id);
      } catch {
        return;
      }
      memServers.delete(id);
    }
  }
  try {
    if (!fs.existsSync(SERVERS_BASE)) return;
    for (const n of fs.readdirSync(SERVERS_BASE)) {
      if (String(n).startsWith(PREFIX)) {
        try {
          stopJobsForServer(n);
        } catch {
          return;
        }
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

async function api(serverId, p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + `/api/servers/${serverId}${p}`, {
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

describe("schedules validation", () => {
  before(async () => {
    cleanupAll();
    app = express();
    app.use(express.json());
    app.use("/api/servers", schedulesRouter);
    await new Promise((resolve) => {
      httpServer = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${httpServer.address().port}`;
  });

  after(async () => {
    try {
      await new Promise((resolve) => httpServer.close(resolve));
    } catch {
      return;
    }
    cleanupAll();
  });

  it("rejects missing cron and missing action", async () => {
    const srv = makeServer();
    try {
      let r = await api(srv.id, "/schedules", { method: "POST", body: { action: "start" } });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /cron is required/);
      r = await api(srv.id, "/schedules", { method: "POST", body: { cron: "* * * * *" } });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /action is required/);
      r = await api(srv.id, "/schedules", { method: "POST", body: {} });
      assert.equal(r.status, 400);
    } finally {
      cleanupServer(srv);
    }
  });

  it("rejects unknown action", async () => {
    const srv = makeServer();
    try {
      const r = await api(srv.id, "/schedules", {
        method: "POST",
        body: { cron: "* * * * *", action: "nuke" },
      });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /action must be one of/);
    } finally {
      cleanupServer(srv);
    }
  });

  it("rejects bad cron expression", async () => {
    const srv = makeServer();
    try {
      for (const bad of ["not-a-cron", "bad", "61 * * * *"]) {
        const r = await api(srv.id, "/schedules", {
          method: "POST",
          body: { cron: bad, action: "start" },
        });
        assert.equal(r.status, 400, `expected 400 for cron ${bad}`);
        assert.match(r.json.error, /invalid cron/);
      }
    } finally {
      cleanupServer(srv);
    }
  });

  it("rejects command action without payload.command", async () => {
    const srv = makeServer();
    try {
      let r = await api(srv.id, "/schedules", {
        method: "POST",
        body: { cron: "* * * * *", action: "command" },
      });
      assert.equal(r.status, 400);
      assert.match(r.json.error, /payload\.command/);
      r = await api(srv.id, "/schedules", {
        method: "POST",
        body: { cron: "* * * * *", action: "command", payload: {} },
      });
      assert.equal(r.status, 400);
      r = await api(srv.id, "/schedules", {
        method: "POST",
        body: { cron: "* * * * *", action: "command", payload: { command: "" } },
      });
      assert.equal(r.status, 400);
    } finally {
      cleanupServer(srv);
    }
  });

  it("accepts command with payload and other valid actions", async () => {
    const srv = makeServer();
    try {
      let r = await api(srv.id, "/schedules", {
        method: "POST",
        body: { cron: "* * * * *", action: "command", payload: { command: "say hi" } },
      });
      assert.equal(r.status, 201);
      assert.equal(r.json.action, "command");
      r = await api(srv.id, "/schedules", {
        method: "POST",
        body: { cron: "0 * * * *", action: "backup", name: "nightly" },
      });
      assert.equal(r.status, 201);
    } finally {
      cleanupServer(srv);
    }
  });

  it("creates, lists and deletes a schedule", async () => {
    const srv = makeServer();
    try {
      let r = await api(srv.id, "/schedules", {
        method: "POST",
        body: { cron: "* * * * *", action: "start", name: "boot" },
      });
      assert.equal(r.status, 201);
      assert.ok(r.json.id);
      const sid = r.json.id;
      r = await api(srv.id, "/schedules");
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.json));
      assert.ok(r.json.find((s) => s.id === sid));
      r = await api(srv.id, `/schedules/${sid}`, { method: "DELETE" });
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      r = await api(srv.id, "/schedules");
      assert.equal(r.status, 200);
      assert.equal(r.json.find((s) => s.id === sid), undefined);
    } finally {
      cleanupServer(srv);
    }
  });

  it("delete unknown schedule returns 404", async () => {
    const srv = makeServer();
    try {
      const r = await api(srv.id, "/schedules/no-such-id", { method: "DELETE" });
      assert.equal(r.status, 404);
    } finally {
      cleanupServer(srv);
    }
  });

  it("readSchedules returns [] for unknown and round-trips writes", () => {
    const id = `${PREFIX}direct-${process.pid}-${Date.now()}`;
    try {
      assert.deepEqual(readSchedules(`${PREFIX}no-such-${process.pid}-${Date.now()}`), []);
      const rows = [
        { id: "a", name: "a", cron: "* * * * *", action: "start", payload: null, enabled: true },
      ];
      writeSchedules(id, rows);
      assert.deepEqual(readSchedules(id), rows);
      writeSchedules(id, []);
      assert.deepEqual(readSchedules(id), []);
    } finally {
      try {
        fs.rmSync(path.join(SERVERS_BASE, id), { recursive: true, force: true });
      } catch {
        return;
      }
    }
  });
});
