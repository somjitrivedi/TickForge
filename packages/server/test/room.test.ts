import { test } from "node:test";
import assert from "node:assert/strict";
import { BinaryWriter, MessageType, ProtocolError, decodeWith } from "@tickforge/protocol";
import type { SnapshotMessage } from "@tickforge/protocol";
import { MAX_QUEUED_INPUTS, Room, RoomManager, Store, silentLogger } from "@tickforge/server";
import { FakeConn, counterCodec, counterGame } from "./helpers.ts";

const b = (v: number) => new BinaryWriter().u8(v).finish();

function makeRoom(maxPlayers = 4) {
  const room = new Room("r", counterGame, counterCodec, maxPlayers, 1);
  const conn = new FakeConn();
  room.add({ id: 1, name: "a", conn, sessionId: 1 });
  return { room, conn };
}

test("inputs are applied one per tick in sequence order", () => {
  const { room } = makeRoom();
  room.receiveInputs(1, 1, [b(1), b(2), b(3)]);
  room.step();
  assert.equal(room.state.totals.get(1), 1);
  room.step();
  room.step();
  assert.equal(room.state.totals.get(1), 6);
  assert.equal(room.players.get(1)!.lastProcessedSeq, 3);
  assert.equal(room.tick, 3);
});

test("redundant resends are de-duplicated", () => {
  const { room } = makeRoom();
  room.receiveInputs(1, 1, [b(1), b(2)]);
  room.receiveInputs(1, 1, [b(1), b(2), b(3)]);
  assert.deepEqual(
    room.players.get(1)!.queue.map((q) => q.seq),
    [1, 2, 3],
  );
});

test("the last input repeats when the queue runs dry", () => {
  const { room } = makeRoom();
  room.receiveInputs(1, 1, [b(5)]);
  room.step();
  room.step();
  room.step();
  assert.equal(room.state.totals.get(1), 15);
  assert.equal(room.players.get(1)!.lastProcessedSeq, 1);
});

test("players start on the neutral input", () => {
  const { room } = makeRoom();
  room.step();
  assert.equal(room.state.totals.get(1), 0);
});

test("queue overflow drops the oldest inputs", () => {
  const { room } = makeRoom();
  const burst = Array.from({ length: 12 }, () => b(1));
  room.receiveInputs(1, 1, burst);
  const p = room.players.get(1)!;
  assert.equal(p.queue.length, MAX_QUEUED_INPUTS);
  assert.equal(p.queue[0]!.seq, 12 - MAX_QUEUED_INPUTS + 1);
  assert.equal(p.droppedInputs, 12 - MAX_QUEUED_INPUTS);
});

test("invalid input payloads throw and leave the queue untouched", () => {
  const { room } = makeRoom();
  assert.throws(() => room.receiveInputs(1, 1, [b(42)]), ProtocolError);
  assert.throws(() => room.receiveInputs(1, 1, [new Uint8Array([1, 2])]), /trailing/);
  assert.equal(room.players.get(1)!.queue.length, 0);
});

test("snapshots carry each player's own ack and the encoded state", () => {
  const room = new Room("r", counterGame, counterCodec, 4, 1);
  const c1 = new FakeConn();
  const c2 = new FakeConn();
  room.add({ id: 1, name: "a", conn: c1, sessionId: 1 });
  room.add({ id: 2, name: "b", conn: c2, sessionId: 2 });
  room.receiveInputs(1, 1, [b(3), b(4)]);
  room.step();
  room.broadcastSnapshot();
  const s1 = c1.sent[0] as SnapshotMessage;
  const s2 = c2.sent[0] as SnapshotMessage;
  assert.equal(s1.type, MessageType.Snapshot);
  assert.equal(s1.ackSeq, 1);
  assert.equal(s2.ackSeq, 0);
  assert.equal(s1.tick, 1);
  const state = decodeWith(counterCodec.readState, s1.state);
  assert.deepEqual([...state.totals], [[1, 3], [2, 0]]);
});

test("capacity and duplicates are enforced", () => {
  const room = new Room("r", counterGame, counterCodec, 1, 1);
  room.add({ id: 1, name: "a", conn: new FakeConn(), sessionId: 1 });
  assert.ok(room.isFull);
  assert.throws(() => room.add({ id: 2, name: "b", conn: new FakeConn(), sessionId: 2 }), /full/);
  room.remove(1);
  room.add({ id: 2, name: "b", conn: new FakeConn(), sessionId: 2 });
  assert.throws(() => room.add({ id: 2, name: "b", conn: new FakeConn(), sessionId: 3 }), /already/);
});

function manager(maxRooms = 2, maxPlayersPerRoom = 2) {
  const store = Store.open(":memory:");
  let n = 0;
  const m = new RoomManager(
    counterGame,
    counterCodec,
    store,
    { maxRooms, maxPlayersPerRoom, seed: () => 7, roomId: () => `room${++n}` },
    silentLogger,
  );
  const guest = () => store.createGuest("p").playerId;
  return { m, store, guest };
}

test("auto-join fills the fullest open room before creating another", () => {
  const { m, guest } = manager(3, 2);
  const ids = [guest(), guest(), guest()];
  const rooms = ids.map((playerId) => {
    const r = m.join({ playerId, name: "p", roomId: "", conn: new FakeConn() });
    assert.ok(r.ok);
    return r.room.id;
  });
  assert.deepEqual(rooms, ["room1", "room1", "room2"]);
  assert.equal(m.playerCount, 3);
});

test("join errors: unknown room, full room, server full, already joined", () => {
  const { m, guest } = manager(1, 1);
  const a = guest();
  assert.ok(m.join({ playerId: a, name: "a", roomId: "", conn: new FakeConn() }).ok);
  const codeOf = (r: ReturnType<typeof m.join>) => (r.ok ? 0 : r.code);
  assert.equal(codeOf(m.join({ playerId: guest(), name: "b", roomId: "missing", conn: new FakeConn() })), 4);
  assert.equal(codeOf(m.join({ playerId: guest(), name: "b", roomId: "room1", conn: new FakeConn() })), 5);
  assert.equal(codeOf(m.join({ playerId: guest(), name: "b", roomId: "", conn: new FakeConn() })), 6);
  assert.equal(codeOf(m.join({ playerId: a, name: "a", roomId: "", conn: new FakeConn() })), 9);
});

test("last player leaving closes the room in memory and in SQLite", () => {
  const { m, store, guest } = manager();
  const a = guest();
  const r = m.join({ playerId: a, name: "a", roomId: "", conn: new FakeConn() });
  assert.ok(r.ok);
  r.room.step();
  r.room.step();
  m.leave(a, "left");
  assert.equal(m.rooms.size, 0);
  assert.equal(m.roomOf(a), undefined);
  const rec = store.getRoom("room1")!;
  assert.equal(rec.status, "closed");
  assert.equal(rec.finalTick, 2);
  assert.equal(rec.seed, 7);
  assert.equal(store.listSessions("room1")[0]!.leaveReason, "left");
});

test("a crashing room is isolated from the others", () => {
  const { m, guest } = manager(2, 1);
  const a = guest();
  const bId = guest();
  const ra = m.join({ playerId: a, name: "a", roomId: "", conn: new FakeConn() });
  const rb = m.join({ playerId: bId, name: "b", roomId: "", conn: new FakeConn() });
  assert.ok(ra.ok && rb.ok);
  ra.room.step = () => {
    throw new Error("boom");
  };
  const crashed: string[] = [];
  m.tickAll((room) => crashed.push(room.id));
  assert.deepEqual(crashed, [ra.room.id]);
  assert.equal(rb.room.tick, 1);
});

test("closeAll evicts everyone and records the reason", () => {
  const { m, store, guest } = manager(2, 1);
  const a = guest();
  const bId = guest();
  m.join({ playerId: a, name: "a", roomId: "", conn: new FakeConn() });
  m.join({ playerId: bId, name: "b", roomId: "", conn: new FakeConn() });
  const evicted = m.closeAll("shutdown");
  assert.deepEqual(evicted.map((p) => p.id).sort(), [a, bId].sort());
  assert.equal(m.rooms.size, 0);
  assert.equal(store.listSessions("room1")[0]!.leaveReason, "shutdown");
  assert.equal(store.getRoom("room2")!.status, "closed");
});
