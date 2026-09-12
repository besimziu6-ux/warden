"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { safePath, serverRoot } = require("../src/routes/files");

const ID = "safepath-test-server";

describe("safePath jail", () => {
  it("resolves empty and dot to the server root", () => {
    for (const rel of ["", ".", "./"]) {
      const jail = safePath(ID, rel);
      assert.ok(jail, `expected jail for ${JSON.stringify(rel)}`);
      assert.equal(jail.resolved, jail.root);
      assert.equal(jail.root, serverRoot(ID));
    }
  });

  it("keeps normal nested paths inside the jail", () => {
    const jail = safePath(ID, "world/level.dat");
    assert.ok(jail);
    assert.ok(jail.resolved.startsWith(jail.root + path.sep));
    assert.equal(path.basename(jail.resolved), "level.dat");
  });

  it("rejects parent-directory escapes", () => {
    for (const rel of ["..", "../..", "a/../../..", "../../etc/passwd"]) {
      assert.equal(safePath(ID, rel), null, `expected null for ${rel}`);
    }
  });

  it("resolves inner dot-dot that stays inside", () => {
    const jail = safePath(ID, "a/../b");
    assert.ok(jail);
    assert.equal(path.basename(jail.resolved), "b");
    assert.ok(jail.resolved.startsWith(jail.root + path.sep));
  });

  it("treats leading slashes as jail-relative, not absolute", () => {
    const jail = safePath(ID, "/server.properties");
    assert.ok(jail);
    assert.ok(jail.resolved.startsWith(jail.root + path.sep));
    assert.equal(path.basename(jail.resolved), "server.properties");
  });

  it("rejects absolute escape outside the root", () => {
    assert.equal(safePath(ID, "/../escape"), null);
  });

  it("handles null/undefined as root", () => {
    for (const rel of [null, undefined]) {
      const jail = safePath(ID, rel);
      assert.ok(jail);
      assert.equal(jail.resolved, jail.root);
    }
  });
});
