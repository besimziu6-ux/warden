"use strict";

process.env.DOCKER_MOCK = "1";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const docker = require("../src/lib/docker");

const TWO_GIB = 2 * 1024 * 1024 * 1024;

function fakeServer(id) {
  return { id, status: "created", env: {} };
}

describe("lifecycle state machine (docker mock)", () => {
  beforeEach(() => {
    docker._resetForTests();
  });

  it("enforces isolation defaults (2G ram, 2 cpus, 256 pids, uid 1000:1000)", async () => {
    await docker.check();
    assert.equal(docker.isMock(), true);
    const limits = docker.limitsFor({ id: "x", env: {} });
    assert.equal(limits.Memory, TWO_GIB);
    assert.equal(limits.MemorySwap, TWO_GIB);
    assert.equal(limits.NanoCpus, 2 * 1000 * 1000 * 1000);
    assert.equal(limits.PidsLimit, 256);
    assert.equal(limits.User, "1000:1000");
    assert.deepEqual(docker.DEFAULT_LIMITS.Memory, TWO_GIB);
  });

  it("honours per-server limit overrides", () => {
    const limits = docker.limitsFor({ id: "x", limits: { Memory: 4 * TWO_GIB, User: "2000:2000" } });
    assert.equal(limits.Memory, 4 * TWO_GIB);
    assert.equal(limits.User, "2000:2000");
    assert.equal(limits.PidsLimit, 256);
  });

  it("runs created -> running -> stopped -> running -> killed", async () => {
    const server = fakeServer("lifecycle-1");

    const cid = await docker.createServer(server, { ports: [] });
    assert.equal(cid, "mock-lifecycle-1");
    assert.equal(await docker.inspectStatus(server), "created");

    let r = await docker.start(server);
    assert.deepEqual(r, { status: "running", mock: true });
    assert.equal(await docker.inspectStatus(server), "running");

    r = await docker.stop(server);
    assert.deepEqual(r, { status: "stopped", mock: true });
    assert.equal(await docker.inspectStatus(server), "stopped");

    r = await docker.restart(server);
    assert.deepEqual(r, { status: "running", mock: true });
    assert.equal(await docker.inspectStatus(server), "running");

    r = await docker.kill(server);
    assert.deepEqual(r, { status: "killed", mock: true });
    assert.equal(await docker.inspectStatus(server), "killed");
  });

  it("keeps per-server states independent", async () => {
    const a = fakeServer("lifecycle-a");
    const b = fakeServer("lifecycle-b");
    await docker.createServer(a, { ports: [] });
    await docker.createServer(b, { ports: [] });
    await docker.start(a);
    assert.equal(await docker.inspectStatus(a), "running");
    assert.equal(await docker.inspectStatus(b), "created");
    await docker.stop(a);
    await docker.start(b);
    assert.equal(await docker.inspectStatus(a), "stopped");
    assert.equal(await docker.inspectStatus(b), "running");
  });

  it("falls back to server.status for never-created servers", async () => {
    assert.equal(await docker.inspectStatus(fakeServer("never-seen")), "created");
    assert.equal(
      await docker.inspectStatus({ id: "never-seen-2", status: "stopped", env: {} }),
      "stopped"
    );
  });
});
