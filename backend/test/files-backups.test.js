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

const PREFIX = "test-fb-";
const admin = { id: "u-test-fb-admin", username: "fb-admin", role: "admin", createdAt: "2026-01-01" };

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

const { safePath, serverRoot } = require("../src/routes/files");
const filesRouter = require("../src/routes/files");
const backupsRouter = require("../src/routes/backups");
const { isUnsafeTarEntry, listBackups } = require("../src/routes/backups");

const DATA_DIR = path.resolve(__dirname, "../../data");
const SERVERS_BASE = path.join(DATA_DIR, "servers");
const BACKUPS_BASE = path.join(DATA_DIR, "backups");

let app;
let httpServer;
let base;
let seq = 0;

function makeServer() {
  seq += 1;
  const id = `${PREFIX}${process.pid}-${Date.now()}-${seq}`;
  return store.create({
    id,
    name: `${PREFIX}srv-${seq}`,
    game: "minecraft-java",
    env: {},
    status: "created",
    ownerId: admin.id,
  });
}

function cleanupServer(srv) {
  if (!srv) return;
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
  try {
    fs.rmSync(path.join(BACKUPS_BASE, String(srv.id)), { recursive: true, force: true });
  } catch {
    return;
  }
}

function cleanupAll() {
  for (const id of Array.from(memServers.keys())) {
    if (String(id).startsWith(PREFIX)) memServers.delete(id);
  }
  for (const baseDir of [SERVERS_BASE, BACKUPS_BASE]) {
    try {
      if (!fs.existsSync(baseDir)) continue;
      for (const n of fs.readdirSync(baseDir)) {
        if (String(n).startsWith(PREFIX)) {
          try {
            fs.rmSync(path.join(baseDir, n), { recursive: true, force: true });
          } catch {
            return;
          }
        }
      }
    } catch {
      return;
    }
  }
}

async function api(p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(base + p, { method: opts.method || "GET", headers, body });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe("files jail edge cases", () => {
  before(async () => {
    cleanupAll();
    app = express();
    app.use(express.json());
    app.use("/api/servers", filesRouter);
    app.use("/api/servers", backupsRouter);
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

  it("rejects parent-directory escapes via direct import", () => {
    const id = `${PREFIX}jail-1`;
    for (const rel of ["..", "../..", "a/../../..", "../../etc/passwd", "../evil.txt"]) {
      assert.equal(safePath(id, rel), null, `expected null for ${rel}`);
    }
  });

  it("resolves inner dot-dot staying inside and normal nested paths", () => {
    const id = `${PREFIX}jail-1`;
    const jail = safePath(id, "a/../b");
    assert.ok(jail);
    assert.equal(path.basename(jail.resolved), "b");
    assert.ok(jail.resolved.startsWith(jail.root + path.sep));
    const nested = safePath(id, "world/level.dat");
    assert.ok(nested);
    assert.ok(nested.resolved.startsWith(nested.root + path.sep));
  });

  it("treats leading slashes as jail-relative and handles empty/null", () => {
    const id = `${PREFIX}jail-1`;
    for (const rel of ["", ".", "./", null, undefined]) {
      const jail = safePath(id, rel);
      assert.ok(jail);
      assert.equal(jail.resolved, jail.root);
      assert.equal(jail.root, serverRoot(id));
    }
    const jail = safePath(id, "/server.properties");
    assert.ok(jail);
    assert.ok(jail.resolved.startsWith(jail.root + path.sep));
    assert.equal(safePath(id, "/../escape"), null);
  });

  it("rejects deep traversal that escapes through subdirs", () => {
    const id = `${PREFIX}jail-1`;
    assert.equal(safePath(id, "a/b/../../../etc"), null);
    assert.equal(safePath(id, "foo/bar/../../.."), null);
    assert.equal(safePath(id, "/a/../../etc/passwd"), null);
  });

  it("rejects traversal over HTTP for list and write", async () => {
    const srv = makeServer();
    try {
      let r = await api(`/api/servers/${srv.id}/files?path=${encodeURIComponent("../../etc/passwd")}`);
      assert.equal(r.status, 400);
      assert.match(r.json.error, /invalid path/);
      r = await api(`/api/servers/${srv.id}/files`, {
        method: "PUT",
        body: { path: "../evil.txt", content: "hi" },
      });
      assert.equal(r.status, 400);
    } finally {
      cleanupServer(srv);
    }
  });

  it("isUnsafeTarEntry rejects absolute, traversal and empty entries", () => {
    assert.equal(isUnsafeTarEntry("/abs.tgz"), true);
    assert.equal(isUnsafeTarEntry("../evil.tgz"), true);
    assert.equal(isUnsafeTarEntry("a/../../b.tgz"), true);
    assert.equal(isUnsafeTarEntry(""), true);
    assert.equal(isUnsafeTarEntry(null), true);
    assert.equal(isUnsafeTarEntry("world/level.dat"), false);
    assert.equal(isUnsafeTarEntry("backup.tgz"), false);
    assert.equal(isUnsafeTarEntry("dir/sub/file.tar.gz"), false);
  });

  it("listBackups only surfaces tgz/tar.gz files", () => {
    const id = `${PREFIX}list-${process.pid}-${Date.now()}`;
    const dir = path.join(BACKUPS_BASE, id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, "a.tgz"), "x");
      fs.writeFileSync(path.join(dir, "b.tar.gz"), "x");
      fs.writeFileSync(path.join(dir, "c.zip"), "x");
      fs.writeFileSync(path.join(dir, "d.txt"), "x");
      fs.mkdirSync(path.join(dir, "e.tgz"), { recursive: true });
      const items = listBackups(id);
      const names = items.map((i) => i.file).sort();
      assert.deepEqual(names, ["a.tgz", "b.tar.gz"]);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        return;
      }
    }
  });

  it("backup download and delete reject non-tgz names with 400", async () => {
    const srv = makeServer();
    try {
      for (const bad of ["evil.zip", "evil.txt", "backup.tar", "noext"]) {
        let r = await api(`/api/servers/${srv.id}/backups/${bad}/download`);
        assert.equal(r.status, 400, `expected 400 for download ${bad}`);
        r = await api(`/api/servers/${srv.id}/backups/${bad}`, { method: "DELETE" });
        assert.equal(r.status, 400, `expected 400 for delete ${bad}`);
      }
      const r = await api(`/api/servers/${srv.id}/backups/evil.tgz/download`);
      assert.equal(r.status, 404);
    } finally {
      cleanupServer(srv);
    }
  });

  it("backup traversal stays inside the backup dir", async () => {
    const srv = makeServer();
    const dir = path.join(BACKUPS_BASE, srv.id);
    fs.mkdirSync(dir, { recursive: true });
    const outsideName = `${PREFIX}outside-${process.pid}.tgz`;
    const outsidePath = path.join(BACKUPS_BASE, outsideName);
    fs.writeFileSync(outsidePath, "outside-secret");
    try {
      const r = await api(
        `/api/servers/${srv.id}/backups/${encodeURIComponent("..")}%2F${outsideName}/download`
      );
      assert.notEqual(r.status, 200);
      assert.ok(r.status === 400 || r.status === 404, `expected 400/404 got ${r.status}`);
    } finally {
      try {
        fs.rmSync(outsidePath, { force: true });
      } catch {
        return;
      }
      cleanupServer(srv);
    }
  });

  it("upload rejects traversal dir and missing file", async () => {
    const srv = makeServer();
    try {
      const fd1 = new FormData();
      fd1.append("file", new Blob(["hello"], { type: "text/plain" }), "evil.txt");
      let res = await fetch(
        `${base}/api/servers/${srv.id}/files/upload?path=${encodeURIComponent("../escape")}`,
        { method: "POST", body: fd1 }
      );
      assert.equal(res.status, 400);
      try {
        await res.text();
      } catch {
        return;
      }

      res = await fetch(`${base}/api/servers/${srv.id}/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      try {
        await res.text();
      } catch {
        return;
      }
    } finally {
      cleanupServer(srv);
    }
  });

  it("upload stores inside jail and sanitizes evil filenames", async () => {
    const srv = makeServer();
    try {
      const fd = new FormData();
      fd.append("file", new Blob(["hello world"], { type: "text/plain" }), "hello.txt");
      let res = await fetch(`${base}/api/servers/${srv.id}/files/upload?path=/`, {
        method: "POST",
        body: fd,
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.name, "hello.txt");

      const root = path.join(SERVERS_BASE, srv.id);
      assert.ok(fs.existsSync(path.join(root, "hello.txt")));

      const fd2 = new FormData();
      fd2.append("file", new Blob(["evil"], { type: "text/plain" }), "../../evil.txt");
      res = await fetch(`${base}/api/servers/${srv.id}/files/upload`, { method: "POST", body: fd2 });
      assert.equal(res.status, 201);
      const body2 = await res.json();
      assert.equal(body2.name, "evil.txt");
      assert.ok(fs.existsSync(path.join(root, "evil.txt")));
      assert.equal(fs.existsSync(path.join(SERVERS_BASE, "evil.txt")), false);
    } finally {
      cleanupServer(srv);
    }
  });
});
