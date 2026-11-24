import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BinaryWriter,
  ErrorCode,
  LeaveReason,
  Limits,
  MessageType,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeMessage,
  encodeMessage,
  isMessageType,
} from "@tickforge/protocol";
import type { Message } from "@tickforge/protocol";

test("protocol version is a positive integer", () => {
  assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0);
});

test("message type codes are unique and fit in one byte", () => {
  const codes = Object.values(MessageType);
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.ok(c > 0 && c < 256);
});

test("isMessageType recognises known codes only", () => {
  assert.ok(isMessageType(MessageType.Snapshot));
  assert.ok(!isMessageType(0));
  assert.ok(!isMessageType(255));
});

const samples: Message[] = [
  { type: MessageType.Hello, version: 1, name: "Ana", roomId: "abc", token: "t0k" },
  { type: MessageType.Welcome, playerId: 42, roomId: "abc", tick: 1000, tickRate: 30, token: "" },
  { type: MessageType.Input, firstSeq: 7, inputs: [new Uint8Array([1]), new Uint8Array([2, 3])] },
  { type: MessageType.Snapshot, tick: 9, ackSeq: 8, state: new Uint8Array([1, 2, 3, 4]) },
  { type: MessageType.Ping, nonce: 5, clientTime: 1234.5 },
  { type: MessageType.Pong, nonce: 5, clientTime: 1234.5, serverTick: 77 },
  { type: MessageType.Leave, reason: LeaveReason.Replaced },
  { type: MessageType.Error, code: ErrorCode.RoomFull, message: "full" },
];

test("every message type round-trips", () => {
  for (const m of samples) assert.deepEqual(decodeMessage(encodeMessage(m)), m, `type ${m.type}`);
});

test("a shared writer can encode many messages", () => {
  const w = new BinaryWriter(2);
  const encoded = samples.map((m) => encodeMessage(m, w));
  encoded.forEach((bytes, i) => assert.deepEqual(decodeMessage(bytes), samples[i]));
});

test("first byte is the message type", () => {
  for (const m of samples) assert.equal(encodeMessage(m)[0], m.type);
});

test("unknown type, empty frame and trailing garbage are rejected", () => {
  assert.throws(() => decodeMessage(new Uint8Array([200])), /Unknown message type/);
  assert.throws(() => decodeMessage(new Uint8Array([])), ProtocolError);
  const ping = encodeMessage({ type: MessageType.Ping, nonce: 1, clientTime: 0 });
  assert.throws(() => decodeMessage(new Uint8Array([...ping, 0])), /trailing/);
});

test("input counts outside the limit are rejected both ways", () => {
  assert.throws(() => encodeMessage({ type: MessageType.Input, firstSeq: 1, inputs: [] }), ProtocolError);
  const tooMany = Array.from({ length: Limits.inputsPerMessage + 1 }, () => new Uint8Array([0]));
  assert.throws(() => encodeMessage({ type: MessageType.Input, firstSeq: 1, inputs: tooMany }), ProtocolError);
  const forged = new BinaryWriter().u8(MessageType.Input).u32(1).varuint(0).finish();
  assert.throws(() => decodeMessage(forged), /Input count/);
});

test("oversized hello fields are rejected", () => {
  const longName = "x".repeat(Limits.nameBytes + 1);
  assert.throws(
    () => encodeMessage({ type: MessageType.Hello, version: 1, name: longName, roomId: "", token: "" }),
    /name exceeds/,
  );
  const forged = new BinaryWriter().u8(MessageType.Hello).u16(1).string(longName).string("").string("").finish();
  assert.throws(() => decodeMessage(forged), /exceeds limit/);
});

test("unknown error codes and leave reasons are rejected", () => {
  assert.throws(() => decodeMessage(new BinaryWriter().u8(MessageType.Error).u16(999).string("x").finish()), /error code/);
  assert.throws(() => decodeMessage(new Uint8Array([MessageType.Leave, 99])), /leave reason/);
});

test("long error messages are truncated on encode", () => {
  const m = decodeMessage(
    encodeMessage({ type: MessageType.Error, code: ErrorCode.BadMessage, message: "e".repeat(5000) }),
  );
  assert.equal(m.type === MessageType.Error && m.message.length, Limits.errorBytes);
});
