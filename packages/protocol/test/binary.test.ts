import { test } from "node:test";
import assert from "node:assert/strict";
import { BinaryReader, BinaryWriter, ProtocolError } from "@tickforge/protocol";

test("primitives round-trip", () => {
  const w = new BinaryWriter(4);
  w.u8(255).u16(65535).u32(0xffffffff).i32(-2147483648).i32(2147483647).f64(-1.5).string("héllo ✓");
  const r = new BinaryReader(w.finish());
  assert.equal(r.u8(), 255);
  assert.equal(r.u16(), 65535);
  assert.equal(r.u32(), 0xffffffff);
  assert.equal(r.i32(), -2147483648);
  assert.equal(r.i32(), 2147483647);
  assert.equal(r.f64(), -1.5);
  assert.equal(r.string(64), "héllo ✓");
  r.end();
});

test("varuint uses minimal bytes and round-trips edges", () => {
  const cases: Array<[number, number]> = [
    [0, 1],
    [127, 1],
    [128, 2],
    [16383, 2],
    [16384, 3],
    [0xffffffff, 5],
  ];
  for (const [v, len] of cases) {
    const bytes = new BinaryWriter().varuint(v).finish();
    assert.equal(bytes.length, len, `length for ${v}`);
    assert.equal(new BinaryReader(bytes).varuint(), v);
  }
});

test("writer grows past its initial capacity", () => {
  const w = new BinaryWriter(1);
  for (let i = 0; i < 1000; i++) w.u32(i);
  assert.equal(w.length, 4000);
  const r = new BinaryReader(w.finish());
  for (let i = 0; i < 1000; i++) assert.equal(r.u32(), i);
});

test("reset reuses the writer and finish returns an independent copy", () => {
  const w = new BinaryWriter();
  const a = w.u8(1).finish();
  const b = w.reset().u8(2).finish();
  assert.deepEqual([...a], [1]);
  assert.deepEqual([...b], [2]);
});

test("out-of-range writes throw", () => {
  const w = new BinaryWriter();
  assert.throws(() => w.u8(256), ProtocolError);
  assert.throws(() => w.u16(-1), ProtocolError);
  assert.throws(() => w.u32(1.5), ProtocolError);
  assert.throws(() => w.i32(2 ** 31), ProtocolError);
  assert.throws(() => w.f64(Number.NaN), ProtocolError);
});

test("truncated reads throw ProtocolError", () => {
  assert.throws(() => new BinaryReader(new Uint8Array([1])).u16(), ProtocolError);
  assert.throws(() => new BinaryReader(new Uint8Array([0x80])).varuint(), ProtocolError);
  assert.throws(() => new BinaryReader(new Uint8Array([5, 1, 2])).bytes(10), ProtocolError);
});

test("oversized and over-long fields are rejected", () => {
  const big = new BinaryWriter().bytes(new Uint8Array(20)).finish();
  assert.throws(() => new BinaryReader(big).bytes(10), /exceeds limit/);
  assert.throws(() => new BinaryReader(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x7f])).varuint(), /32 bits/);
  assert.throws(() => new BinaryReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])).varuint(), /too long/);
});

test("invalid UTF-8 and trailing bytes are rejected", () => {
  assert.throws(() => new BinaryReader(new Uint8Array([2, 0xc3, 0x28])).string(10), /UTF-8/);
  const r = new BinaryReader(new Uint8Array([1, 2]));
  r.u8();
  assert.throws(() => r.end(), /trailing/);
});

test("reader respects subarray offsets", () => {
  const backing = new Uint8Array([9, 9, 0x34, 0x12, 9]);
  assert.equal(new BinaryReader(backing.subarray(2, 4)).u16(), 0x1234);
});
