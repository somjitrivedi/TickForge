import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClientOptions } from "@tickforge/client";

test("defaults are filled in", () => {
  assert.deepEqual(resolveClientOptions({ url: "ws://localhost:7350" }), {
    url: "ws://localhost:7350/",
    interpolationTicks: 2,
    inputRedundancy: 3,
    pingIntervalMs: 1000,
    connectTimeoutMs: 10_000,
  });
});

test("explicit values are kept", () => {
  const o = resolveClientOptions({
    url: "wss://game.example/play",
    interpolationTicks: 0,
    inputRedundancy: 5,
    pingIntervalMs: 0,
    connectTimeoutMs: 500,
  });
  assert.equal(o.interpolationTicks, 0);
  assert.equal(o.inputRedundancy, 5);
  assert.equal(o.pingIntervalMs, 0);
  assert.equal(o.connectTimeoutMs, 500);
});

test("non-websocket and malformed urls are rejected", () => {
  assert.throws(() => resolveClientOptions({ url: "http://localhost" }), TypeError);
  assert.throws(() => resolveClientOptions({ url: "not a url" }), TypeError);
});

test("out-of-range tuning values are rejected", () => {
  assert.throws(() => resolveClientOptions({ url: "ws://x", interpolationTicks: -1 }), RangeError);
  assert.throws(() => resolveClientOptions({ url: "ws://x", inputRedundancy: 0 }), RangeError);
  assert.throws(() => resolveClientOptions({ url: "ws://x", inputRedundancy: 1.5 }), RangeError);
  assert.throws(() => resolveClientOptions({ url: "ws://x", pingIntervalMs: -5 }), RangeError);
  assert.throws(() => resolveClientOptions({ url: "ws://x", connectTimeoutMs: 10 }), RangeError);
});
