import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig, tickIntervalMs } from "@tickforge/server";

test("defaults apply when env is empty", () => {
  assert.deepEqual(loadConfig({}), {
    host: "0.0.0.0",
    port: 7350,
    tickRate: 30,
    maxRoomsPerWorker: 64,
    maxPlayersPerRoom: 16,
    helloTimeoutMs: 5000,
    dbPath: "data/tickforge.db",
  });
});

test("env overrides are parsed", () => {
  const c = loadConfig({
    TICKFORGE_HOST: "127.0.0.1",
    TICKFORGE_PORT: " 9000 ",
    TICKFORGE_TICK_RATE: "60",
    TICKFORGE_MAX_ROOMS_PER_WORKER: "200",
    TICKFORGE_MAX_PLAYERS_PER_ROOM: "4",
    TICKFORGE_HELLO_TIMEOUT_MS: "2500",
    TICKFORGE_DB_PATH: "/var/lib/tf.db",
  });
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 9000);
  assert.equal(c.tickRate, 60);
  assert.equal(c.maxRoomsPerWorker, 200);
  assert.equal(c.maxPlayersPerRoom, 4);
  assert.equal(c.helloTimeoutMs, 2500);
  assert.equal(c.dbPath, "/var/lib/tf.db");
});

test("blank values fall back to defaults", () => {
  assert.equal(loadConfig({ TICKFORGE_PORT: "  ", TICKFORGE_HOST: "" }).port, 7350);
});

test("all invalid values are reported together", () => {
  try {
    loadConfig({ TICKFORGE_PORT: "70000", TICKFORGE_TICK_RATE: "abc", TICKFORGE_MAX_PLAYERS_PER_ROOM: "2.5" });
    assert.fail("expected ConfigError");
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.issues.length, 3);
    assert.match(err.message, /TICKFORGE_PORT/);
    assert.match(err.message, /TICKFORGE_TICK_RATE/);
    assert.match(err.message, /TICKFORGE_MAX_PLAYERS_PER_ROOM/);
  }
});

test("tick interval derives from tick rate", () => {
  assert.equal(tickIntervalMs({ tickRate: 50 }), 20);
});
