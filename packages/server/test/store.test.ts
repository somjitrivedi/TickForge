import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@tickforge/server";

function fakeClock(start = 1_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("migrations run once and set the schema version", () => {
  const s = Store.open(":memory:");
  assert.equal(s.schemaVersion, 1);
  s.close();
});

test("guest tokens authenticate and update name and last seen", () => {
  const clock = fakeClock();
  const s = Store.open(":memory:", clock);
  const { playerId, token } = s.createGuest("Ana");
  assert.ok(token.length >= 32);
  clock.t = 5_000;
  assert.equal(s.authenticate(token, "Ana2"), playerId);
  const p = s.getPlayer(playerId)!;
  assert.equal(p.name, "Ana2");
  assert.equal(p.createdAt, 1_000);
  assert.equal(p.lastSeenAt, 5_000);
  assert.equal(s.authenticate("wrong", "x"), null);
  s.close();
});

test("tokens are stored hashed, never in plain text", () => {
  const s = Store.open(":memory:");
  const { token } = s.createGuest("Ana");
  const db = (s as unknown as { db: { prepare(sql: string): { all(): Array<Record<string, unknown>> } } }).db;
  const rows = db.prepare("SELECT token_hash FROM players").all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!["token_hash"], token);
  assert.match(String(rows[0]!["token_hash"]), /^[0-9a-f]{64}$/);
  s.close();
});

test("room and session lifecycle", () => {
  const clock = fakeClock();
  const s = Store.open(":memory:", clock);
  const { playerId } = s.createGuest("Ana");
  s.createRoom("r1", "counter", 42, 4);
  assert.deepEqual(s.getRoom("r1"), {
    id: "r1",
    game: "counter",
    status: "open",
    seed: 42,
    maxPlayers: 4,
    createdAt: 1_000,
    closedAt: null,
    finalTick: null,
  });
  const sid = s.openSession("r1", playerId);
  clock.t = 2_000;
  s.closeSession(sid, "left");
  s.closeSession(sid, "kicked");
  const [session] = s.listSessions("r1");
  assert.equal(session!.leaveReason, "left");
  assert.equal(session!.leftAt, 2_000);
  clock.t = 3_000;
  s.closeRoom("r1", 99);
  const room = s.getRoom("r1")!;
  assert.equal(room.status, "closed");
  assert.equal(room.finalTick, 99);
  assert.equal(room.closedAt, 3_000);
  s.close();
});

test("sessions must reference real rooms and players", () => {
  const s = Store.open(":memory:");
  assert.throws(() => s.openSession("nope", 1));
  s.close();
});

test("orphaned rooms and sessions are closed on recovery", () => {
  const s = Store.open(":memory:");
  const a = s.createGuest("A").playerId;
  const b = s.createGuest("B").playerId;
  s.createRoom("r1", "counter", 1, 4);
  s.createRoom("r2", "counter", 2, 4);
  s.openSession("r1", a);
  const done = s.openSession("r2", b);
  s.closeSession(done, "left");
  s.closeRoom("r2", 10);
  assert.deepEqual(s.recoverOrphans(), { rooms: 1, sessions: 1 });
  assert.equal(s.getRoom("r1")!.status, "closed");
  assert.equal(s.listSessions("r1")[0]!.leaveReason, "server_restart");
  assert.equal(s.listSessions("r2")[0]!.leaveReason, "left");
  assert.deepEqual(s.recoverOrphans(), { rooms: 0, sessions: 0 });
  s.close();
});

test("data persists across reopen of a file database", () => {
  const dir = mkdtempSync(join(tmpdir(), "tickforge-store-"));
  try {
    const path = join(dir, "nested", "tf.db");
    const s1 = Store.open(path);
    const { playerId, token } = s1.createGuest("Ana");
    s1.close();
    const s2 = Store.open(path);
    assert.equal(s2.schemaVersion, 1);
    assert.equal(s2.authenticate(token, "Ana"), playerId);
    s2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed transactions roll back", () => {
  const s = Store.open(":memory:");
  assert.throws(() =>
    s.transaction(() => {
      s.createGuest("ghost");
      throw new Error("abort");
    }),
  );
  const db = (s as unknown as { db: { prepare(sql: string): { get(): Record<string, unknown> } } }).db;
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM players").get()["n"]), 0);
  s.close();
});
