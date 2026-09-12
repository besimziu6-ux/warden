"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const auth = require("../src/lib/auth");

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.body = obj;
    return res;
  };
  return res;
}

describe("auth middleware", () => {
  it("tokenFromHeader extracts bearer tokens and rejects junk", () => {
    assert.equal(auth.tokenFromHeader({ headers: {} }), null);
    assert.equal(auth.tokenFromHeader({ headers: { authorization: "" } }), null);
    assert.equal(auth.tokenFromHeader({ headers: { authorization: "Token abc" } }), null);
    assert.equal(auth.tokenFromHeader({ headers: { authorization: "Bearer" } }), null);
    assert.equal(auth.tokenFromHeader({ headers: { authorization: "Bearer abc123" } }), "abc123");
  });

  it("signToken/verifyPayload round-trips and rejects tampered tokens", () => {
    const fake = { id: "u-test-1", username: "tester", role: "user" };
    const token = auth.signToken(fake);
    assert.equal(typeof token, "string");
    const payload = auth.verifyPayload(token);
    assert.equal(payload.sub, fake.id);
    assert.equal(payload.username, fake.username);
    assert.equal(payload.role, "user");
    assert.equal(auth.verifyPayload("garbage"), null);
    assert.equal(auth.verifyPayload(token.slice(0, -2) + "xx"), null);
  });

  it("toPublic strips secrets", () => {
    const pub = auth.toPublic({
      id: "1",
      username: "sam",
      role: "admin",
      createdAt: "2026-01-01",
      passwordHash: "must-not-leak",
    });
    assert.deepEqual(Object.keys(pub).sort(), ["createdAt", "id", "role", "username"]);
    assert.equal(auth.toPublic(null), null);
  });

  it("requireAuth rejects missing and invalid tokens with 401", () => {
    let nextCalled = false;
    let res = mockRes();
    auth.requireAuth({ headers: {} }, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);

    nextCalled = false;
    res = mockRes();
    auth.requireAuth({ headers: { authorization: "Bearer not-a-real-token" } }, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  it("requireAuth rejects a valid token for an unknown user (read-only)", () => {
    const token = auth.signToken({ id: "no-such-user-xyz", username: "ghost", role: "user" });
    const res = mockRes();
    let nextCalled = false;
    auth.requireAuth({ headers: { authorization: `Bearer ${token}` } }, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, "unknown user");
    assert.equal(nextCalled, false);
  });

  it("requireAdmin gates on role", () => {
    let res = mockRes();
    let nextCalled = false;
    auth.requireAdmin({}, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);

    res = mockRes();
    nextCalled = false;
    auth.requireAdmin({ user: { id: "1", username: "u", role: "user" } }, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);

    res = mockRes();
    nextCalled = false;
    auth.requireAdmin({ user: { id: "1", username: "a", role: "admin" } }, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});
