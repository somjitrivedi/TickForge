import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BinaryWriter,
  ErrorCode,
  LeaveReason,
  MessageType,
  PROTOCOL_VERSION,
  decodeWith,
} from "@tickforge/protocol";
import type { Message } from "@tickforge/protocol";
import { sanitizeName } from "@tickforge/server";
import { RawClient, counterCodec, startTestServer, waitFor } from "./helpers.ts";

const hello = (over: Partial<Extract<Message, { type: 1 }>> = {}): Message => ({
  type: MessageType.Hello,
  version: PROTOCOL_VERSION,
  name: "tester",
  roomId: "",
  token: "",
  ...over,
});

const input = (v: number) => new BinaryWriter().u8(v).finish();

test("hello -> welcome -> snapshots acknowledging applied inputs", async () => {
  const t = await startTestServer();
  try {
    const c = await RawClient.open(t.url);
    c.send(hello());
    const welcome = await c.next(MessageType.Welcome);
    assert.ok(welcome.playerId > 0);
    assert.ok(welcome.token.length >= 32);
    assert.equal(welcome.tickRate, 50);
    c.send({ type: MessageType.Input, firstSeq: 1, inputs: [input(2), input(3)] });
    const snap = await waitFor(
      () => c.messages.find((m) => m.type === MessageType.Snapshot && m.ackSeq === 2),
      2000,
      "ack 2",
    );
    assert.equal(snap.type, MessageType.Snapshot);
    const state = decodeWith(counterCodec.readState, snap.state);
    assert.ok(state.totals.get(welcome.playerId)! >= 5);
    assert.equal(t.store.getPlayer(welcome.playerId)!.name, "tester");
    assert.equal(t.store.getRoom(welcome.roomId)!.status, "open");
    c.close();
  } finally {
    await t.stop();
  }
});

test("protocol version mismatch is refused", async () => {
  const t = await startTestServer();
  try {
    const c = await RawClient.open(t.url);
    c.send(hello({ version: PROTOCOL_VERSION + 1 }));
    const err = await c.next(MessageType.Error);
    assert.equal(err.code, ErrorCode.VersionMismatch);
    assert.equal((await c.waitClosed()).code, 1008);
  } finally {
    await t.stop();
  }
});

test("clients that never say hello are dropped", async () => {
  const t = await startTestServer({ helloTimeoutMs: 150 });
  try {
    const c = await RawClient.open(t.url);
    const err = await c.next(MessageType.Error);
    assert.equal(err.code, ErrorCode.HelloTimeout);
    await c.waitClosed();
  } finally {
    await t.stop();
  }
});

test("malformed bytes, text frames and pre-hello messages are rejected", async () => {
  const t = await startTestServer();
  try {
    const garbage = await RawClient.open(t.url);
    garbage.sendBytes(new Uint8Array([250, 1, 2]));
    assert.equal((await garbage.next(MessageType.Error)).code, ErrorCode.BadMessage);

    const text = await RawClient.open(t.url);
    text.sendBytes("hello");
    assert.equal((await text.waitClosed()).code, 1003);

    const early = await RawClient.open(t.url);
    early.send({ type: MessageType.Ping, nonce: 1, clientTime: 0 });
    assert.equal((await early.next(MessageType.Error)).code, ErrorCode.NotJoined);
  } finally {
    await t.stop();
  }
});

test("an invalid game input kicks the sender and records it", async () => {
  const t = await startTestServer();
  try {
    const c = await RawClient.open(t.url);
    c.send(hello());
    const w = await c.next(MessageType.Welcome);
    c.send({ type: MessageType.Input, firstSeq: 1, inputs: [input(99)] });
    assert.equal((await c.next(MessageType.Error)).code, ErrorCode.BadMessage);
    await c.waitClosed();
    await waitFor(() => t.store.getRoom(w.roomId)!.status === "closed", 2000, "room closed");
    assert.equal(t.store.listSessions(w.roomId)[0]!.leaveReason, "kicked");
  } finally {
    await t.stop();
  }
});

test("ping is answered with pong echoing the nonce and client time", async () => {
  const t = await startTestServer();
  try {
    const c = await RawClient.open(t.url);
    c.send(hello());
    await c.next(MessageType.Welcome);
    c.send({ type: MessageType.Ping, nonce: 77, clientTime: 123.25 });
    const pong = await c.next(MessageType.Pong);
    assert.equal(pong.nonce, 77);
    assert.equal(pong.clientTime, 123.25);
    c.close();
  } finally {
    await t.stop();
  }
});

test("join by room id, room full, unknown room", async () => {
  const t = await startTestServer({ maxPlayersPerRoom: 2 });
  try {
    const a = await RawClient.open(t.url);
    a.send(hello({ name: "a" }));
    const wa = await a.next(MessageType.Welcome);

    const b = await RawClient.open(t.url);
    b.send(hello({ name: "b", roomId: wa.roomId }));
    assert.equal((await b.next(MessageType.Welcome)).roomId, wa.roomId);

    const c = await RawClient.open(t.url);
    c.send(hello({ name: "c", roomId: wa.roomId }));
    assert.equal((await c.next(MessageType.Error)).code, ErrorCode.RoomFull);

    const d = await RawClient.open(t.url);
    d.send(hello({ name: "d", roomId: "nope" }));
    assert.equal((await d.next(MessageType.Error)).code, ErrorCode.RoomNotFound);

    const snap = await waitFor(
      () => a.messages.findLast((m) => m.type === MessageType.Snapshot),
      2000,
      "snapshot",
    );
    assert.equal(decodeWith(counterCodec.readState, snap.state).totals.size, 2);
    a.close();
    b.close();
  } finally {
    await t.stop();
  }
});

test("server capacity is enforced", async () => {
  const t = await startTestServer({ maxRoomsPerWorker: 1, maxPlayersPerRoom: 1 });
  try {
    const a = await RawClient.open(t.url);
    a.send(hello());
    await a.next(MessageType.Welcome);
    const b = await RawClient.open(t.url);
    b.send(hello());
    assert.equal((await b.next(MessageType.Error)).code, ErrorCode.ServerFull);
    a.close();
  } finally {
    await t.stop();
  }
});

test("token reconnect keeps identity and replaces the old connection", async () => {
  const t = await startTestServer();
  try {
    const first = await RawClient.open(t.url);
    first.send(hello({ name: "orig" }));
    const w1 = await first.next(MessageType.Welcome);

    const second = await RawClient.open(t.url);
    second.send(hello({ name: "again", token: w1.token }));
    const w2 = await second.next(MessageType.Welcome);
    assert.equal(w2.playerId, w1.playerId);
    assert.equal(w2.token, "");

    assert.equal((await first.next(MessageType.Leave)).reason, LeaveReason.Replaced);
    await first.waitClosed();
    assert.equal(t.server.connectedPlayers, 1);
    assert.equal(t.store.getPlayer(w1.playerId)!.name, "again");
    const reasons = t.store.listSessions(w1.roomId).map((s) => s.leaveReason);
    assert.deepEqual(reasons, ["replaced"]);
    second.close();
  } finally {
    await t.stop();
  }
});

test("unknown tokens are refused", async () => {
  const t = await startTestServer();
  try {
    const c = await RawClient.open(t.url);
    c.send(hello({ token: "forged-token" }));
    assert.equal((await c.next(MessageType.Error)).code, ErrorCode.InvalidToken);
  } finally {
    await t.stop();
  }
});

test("leave and disconnect close sessions with the right reason", async () => {
  const t = await startTestServer({ maxPlayersPerRoom: 2 });
  try {
    const a = await RawClient.open(t.url);
    a.send(hello());
    const wa = await a.next(MessageType.Welcome);
    const b = await RawClient.open(t.url);
    b.send(hello({ roomId: wa.roomId }));
    await b.next(MessageType.Welcome);

    a.send({ type: MessageType.Leave, reason: LeaveReason.ClientLeft });
    assert.equal((await a.waitClosed()).code, 1000);
    b.ws.terminate();
    await waitFor(() => t.store.getRoom(wa.roomId)!.status === "closed", 2000, "room closed");
    const reasons = t.store.listSessions(wa.roomId).map((s) => s.leaveReason);
    assert.deepEqual(reasons, ["left", "disconnected"]);
    assert.equal(t.server.connectedPlayers, 0);
    assert.equal(t.server.rooms.rooms.size, 0);
  } finally {
    await t.stop();
  }
});

test("shutdown notifies players and closes everything in SQLite", async () => {
  const t = await startTestServer();
  const c = await RawClient.open(t.url);
  c.send(hello());
  const w = await c.next(MessageType.Welcome);
  await t.server.stop();
  assert.equal((await c.next(MessageType.Leave)).reason, LeaveReason.ServerShutdown);
  await c.waitClosed();
  assert.equal(t.store.getRoom(w.roomId)!.status, "closed");
  assert.equal(t.store.listSessions(w.roomId)[0]!.leaveReason, "shutdown");
  t.store.close();
});

test("names are sanitised", () => {
  assert.equal(sanitizeName("  Ana\u0000​  "), "Ana");
  assert.equal(sanitizeName("\u0007"), "Player");
  assert.equal(sanitizeName("x".repeat(40)).length, 24);
});
