import { test } from "node:test";
import assert from "node:assert/strict";
import { BinaryWriter, ProtocolError, decodeWith, encodeWith } from "@tickforge/protocol";
import { Button, shooter, shooterCodec } from "@tickforge/demo";

test("state round-trips with identical hash", () => {
  const s = shooter.createState(11);
  for (const id of [3, 1, 2]) shooter.addPlayer(s, id);
  for (let t = 0; t < 30; t++) shooter.step(s, new Map([[1, { buttons: Button.Left | Button.Up }]]));
  const bytes = encodeWith(shooterCodec.writeState, s);
  const back = decodeWith(shooterCodec.readState, bytes);
  assert.equal(shooter.hashState(back), shooter.hashState(s));
  assert.deepEqual([...back.players.keys()], [3, 1, 2]);
  assert.equal(bytes.length, 4 + 4 + 1 + 3 * 13);
});

test("inputs encode to one byte and reject unknown bits", () => {
  const bytes = encodeWith(shooterCodec.writeInput, { buttons: Button.Right | Button.Down });
  assert.deepEqual([...bytes], [Button.Right | Button.Down]);
  assert.deepEqual(decodeWith(shooterCodec.readInput, bytes), { buttons: Button.Right | Button.Down });
  assert.throws(() => decodeWith(shooterCodec.readInput, new Uint8Array([0x10])), ProtocolError);
});

test("forged states are rejected", () => {
  const tooMany = new BinaryWriter().u32(0).u32(1).varuint(5000).finish();
  assert.throws(() => decodeWith(shooterCodec.readState, tooMany), /Too many players/);
  const badHp = new BinaryWriter().u32(0).u32(1).varuint(1).u32(1).i32(0).i32(0).u8(200).finish();
  assert.throws(() => decodeWith(shooterCodec.readState, badHp), /hp/);
});
