"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { EGGS, getEgg, listEggs } = require("../src/games/eggs");

const EXPECTED = {
  "minecraft-java": "itzg/minecraft-server:latest",
  "minecraft-bedrock": "itzg/minecraft-bedrock-server:latest",
  cs2: "joedwards32/cs2:latest",
  rust: "cm2network/rust:latest",
  ark: "hermsi/ark-server:latest",
  valheim: "lloesche/valheim-server:latest",
  terraria: "ryshe/terraria:latest",
};

describe("egg validation", () => {
  it("ships exactly the 7 supported eggs", () => {
    const eggs = listEggs();
    assert.equal(eggs.length, 7);
    assert.deepEqual(new Set(eggs.map((e) => e.id)), new Set(Object.keys(EXPECTED)));
  });

  it("pins each egg to its expected image", () => {
    for (const [id, image] of Object.entries(EXPECTED)) {
      assert.equal(EGGS[id].image, image, `wrong image for ${id}`);
    }
  });

  it("gives every egg id, name, startup, ports and env", () => {
    for (const egg of listEggs()) {
      assert.equal(typeof egg.id, "string");
      assert.ok(egg.id.length > 0);
      assert.equal(typeof egg.name, "string");
      assert.ok(egg.name.length > 0);
      assert.equal(typeof egg.startup, "string");
      assert.ok(egg.startup.length > 0);
      assert.ok(Array.isArray(egg.ports) && egg.ports.length > 0, `${egg.id} needs ports`);
      assert.equal(typeof egg.env, "object");
    }
  });

  it("declares valid port entries (numeric container, tcp/udp)", () => {
    for (const egg of listEggs()) {
      for (const p of egg.ports) {
        assert.equal(typeof p.container, "number", `${egg.id} port must be numeric`);
        assert.ok(p.container > 0 && p.container < 65536);
        assert.match(p.protocol || "tcp", /^(tcp|udp)$/, `${egg.id} bad protocol`);
      }
    }
  });

  it("getEgg returns the egg for known ids and null otherwise", () => {
    assert.equal(getEgg("minecraft-java").image, EXPECTED["minecraft-java"]);
    assert.equal(getEgg("cs2").id, "cs2");
    assert.equal(getEgg("no-such-game"), null);
    assert.equal(getEgg(""), null);
  });
});
