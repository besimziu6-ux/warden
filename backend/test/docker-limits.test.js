"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const docker = require("../src/lib/docker");

const GIB = 1024 * 1024 * 1024;

describe("docker limitsFor", () => {
  it("returns isolation defaults when no limits are set", () => {
    const servers = [undefined, null, {}, { id: "x" }, { id: "x", env: {} }, { id: "x", limits: {} }];
    for (const server of servers) {
      const limits = docker.limitsFor(server);
      assert.equal(limits.Memory, docker.DEFAULT_LIMITS.Memory);
      assert.equal(limits.MemorySwap, docker.DEFAULT_LIMITS.MemorySwap);
      assert.equal(limits.NanoCpus, docker.DEFAULT_LIMITS.NanoCpus);
      assert.equal(limits.PidsLimit, docker.DEFAULT_LIMITS.PidsLimit);
      assert.equal(limits.User, docker.DEFAULT_LIMITS.User);
    }
  });

  it("honours full overrides", () => {
    const limits = docker.limitsFor({
      id: "x",
      limits: {
        Memory: 4 * GIB,
        MemorySwap: 4 * GIB,
        NanoCpus: 1 * 1000 * 1000 * 1000,
        PidsLimit: 512,
        User: "2000:2000",
      },
    });
    assert.equal(limits.Memory, 4 * GIB);
    assert.equal(limits.MemorySwap, 4 * GIB);
    assert.equal(limits.NanoCpus, 1 * 1000 * 1000 * 1000);
    assert.equal(limits.PidsLimit, 512);
    assert.equal(limits.User, "2000:2000");
  });

  it("partial override with only Memory keeps default NanoCpus/PidsLimit", () => {
    const limits = docker.limitsFor({ id: "x", limits: { Memory: 4 * GIB } });
    assert.equal(limits.Memory, 4 * GIB);
    assert.equal(limits.NanoCpus, docker.DEFAULT_LIMITS.NanoCpus);
    assert.equal(limits.PidsLimit, docker.DEFAULT_LIMITS.PidsLimit);
    assert.equal(limits.User, docker.DEFAULT_LIMITS.User);
  });

  it("partial override with only PidsLimit keeps default Memory/NanoCpus", () => {
    const limits = docker.limitsFor({ id: "x", limits: { PidsLimit: 512 } });
    assert.equal(limits.PidsLimit, 512);
    assert.equal(limits.Memory, docker.DEFAULT_LIMITS.Memory);
    assert.equal(limits.NanoCpus, docker.DEFAULT_LIMITS.NanoCpus);
  });

  it("maps fractional cpus to NanoCpus", () => {
    assert.equal(docker.limitsFor({ id: "x", limits: { cpus: 0.5 } }).NanoCpus, 0.5e9);
    assert.equal(docker.limitsFor({ id: "x", limits: { cpus: 2 } }).NanoCpus, 2e9);
    assert.equal(docker.limitsFor({ id: "x", limits: { cpus: "0.5" } }).NanoCpus, 0.5e9);
  });

  it("prefers explicit NanoCpus over cpus and accepts lowercase aliases", () => {
    const limits = docker.limitsFor({ id: "x", limits: { NanoCpus: 1e9, cpus: 0.5 } });
    assert.equal(limits.NanoCpus, 1e9);

    const aliased = docker.limitsFor({
      id: "x",
      limits: { memory: 4 * GIB, nanoCpus: 1e9, pids: 64, user: "2000:2000" },
    });
    assert.equal(aliased.Memory, 4 * GIB);
    assert.equal(aliased.NanoCpus, 1e9);
    assert.equal(aliased.PidsLimit, 64);
    assert.equal(aliased.User, "2000:2000");
  });

  it("clamps tiny values to sane minimums and falls back on garbage", () => {
    const tiny = docker.limitsFor({ id: "x", limits: { Memory: 1, NanoCpus: 1, PidsLimit: 1, cpus: 0 } });
    assert.equal(tiny.Memory, docker.MIN_LIMITS.Memory);
    assert.equal(tiny.NanoCpus, docker.MIN_LIMITS.NanoCpus);
    assert.equal(tiny.PidsLimit, docker.MIN_LIMITS.PidsLimit);

    const negative = docker.limitsFor({ id: "x", limits: { Memory: -5, PidsLimit: -1 } });
    assert.equal(negative.Memory, docker.MIN_LIMITS.Memory);
    assert.equal(negative.PidsLimit, docker.MIN_LIMITS.PidsLimit);

    const garbage = docker.limitsFor({
      id: "x",
      limits: { Memory: "lots", NanoCpus: "lots", PidsLimit: "lots", cpus: "lots" },
    });
    assert.equal(garbage.Memory, docker.DEFAULT_LIMITS.Memory);
    assert.equal(garbage.NanoCpus, docker.DEFAULT_LIMITS.NanoCpus);
    assert.equal(garbage.PidsLimit, docker.DEFAULT_LIMITS.PidsLimit);
  });

  it("raises MemorySwap to match Memory when Memory grows past it", () => {
    const limits = docker.limitsFor({ id: "x", limits: { Memory: 4 * GIB } });
    assert.ok(limits.MemorySwap >= limits.Memory);
  });
});
