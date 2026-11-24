import { test } from "node:test";
import assert from "node:assert/strict";
import { Hasher, hashInts } from "@tickforge/sim";

test("empty input hashes to the FNV-1a offset basis", () => {
  assert.equal(hashInts([]), 0x811c9dc5);
});

test("hash is order-sensitive", () => {
  assert.notEqual(hashInts([1, 2, 3]), hashInts([3, 2, 1]));
});

test("hash matches byte-wise FNV-1a over little-endian int32", () => {
  let h = 0x811c9dc5;
  for (const byte of [0x01, 0x00, 0x00, 0x00]) h = Math.imul(h ^ byte, 0x01000193);
  assert.equal(hashInts([1]), h >>> 0);
});

test("negative integers hash as their int32 bit pattern", () => {
  assert.equal(hashInts([-1]), hashInts([0xffffffff]));
});

test("non-integers are rejected", () => {
  assert.throws(() => new Hasher().int(0.5), TypeError);
  assert.throws(() => new Hasher().int(Number.NaN), TypeError);
});
