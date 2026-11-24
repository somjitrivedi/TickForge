import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng, nextInt, nextRange, nextU32 } from "@tickforge/sim";

test("same seed yields the same sequence", () => {
  const a = createRng(12345);
  const b = createRng(12345);
  for (let i = 0; i < 1000; i++) assert.equal(nextU32(a), nextU32(b));
});

test("different seeds diverge", () => {
  const a = createRng(1);
  const b = createRng(2);
  const seqA = Array.from({ length: 8 }, () => nextU32(a));
  const seqB = Array.from({ length: 8 }, () => nextU32(b));
  assert.notDeepEqual(seqA, seqB);
});

test("zero seed does not get stuck at zero", () => {
  const r = createRng(0);
  assert.notEqual(r.s, 0);
  for (let i = 0; i < 100; i++) assert.notEqual(nextU32(r), 0);
});

test("outputs are unsigned 32-bit integers", () => {
  const r = createRng(0xdeadbeef);
  for (let i = 0; i < 1000; i++) {
    const v = nextU32(r);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff);
  }
});

test("known sequence is stable across runs", () => {
  const r = createRng(1);
  assert.deepEqual([nextU32(r), nextU32(r), nextU32(r)], [270369, 67634689, 2647435461]);
});

test("nextInt stays in range and rejects bad bounds", () => {
  const r = createRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = nextInt(r, 10);
    assert.ok(v >= 0 && v < 10);
  }
  assert.throws(() => nextInt(r, 0), RangeError);
  assert.throws(() => nextInt(r, 1.5), RangeError);
});

test("nextRange is inclusive on both ends", () => {
  const r = createRng(99);
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const v = nextRange(r, 3, 5);
    assert.ok(v >= 3 && v <= 5);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5]);
});
