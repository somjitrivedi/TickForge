import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectError, TickForgeClient } from "@tickforge/client";
import type { Snapshot } from "@tickforge/client";
import { ErrorCode, LeaveReason } from "@tickforge/protocol";
import { GameServer, Store, WebSocketTransport, silentLogger } from "@tickforge/server";
import { ARENA_WIDTH, Button, PLAYER_RADIUS, PLAYER_SPEED, shooter, shooterCodec } from "@tickforge/demo";
import type { ShooterInput, ShooterState } from "@tickforge/demo";

async function startShooter() {
  const store = Store.open(":memory:");
  const server = new GameServer({
    game: shooter,
    codec: shooterCodec,
    config: { tickRate: 60, maxRoomsPerWorker: 4, maxPlayersPerRoom: 4, helloTimeoutMs: 1000 },
    transport: new WebSocketTransport({ host: "127.0.0.1", port: 0 }),
    store,
    logger: silentLogger,
    roomSeed: () => 1234,
  });
  const port = await server.start();
  return {
    server,
    store,
    url: `ws://127.0.0.1:${port}`,
    async stop() {
      await server.stop();
      store.close();
    },
  };
}

function until<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() > deadline) return reject(new Error("timed out"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("client SDK joins, moves its player and gets acks and RTT", async () => {
  const t = await startShooter();
  const client = new TickForgeClient<ShooterState, ShooterInput>(shooterCodec, { url: t.url, pingIntervalMs: 50 });
  try {
    const session = await client.connect({ name: "e2e" });
    assert.equal(client.status, "connected");
    assert.equal(session.tickRate, 60);
    assert.ok(session.token.length >= 32);

    const first = await until(() => client.lastSnapshot);
    const start = first.state.players.get(session.playerId)!;
    let lastSeq = 0;
    for (let i = 0; i < 20; i++) {
      lastSeq = client.sendInput({ buttons: Button.Right });
      await sleep(1000 / 60);
    }
    const acked = await until(() =>
      client.lastSnapshot && client.lastSnapshot.ackSeq === lastSeq ? client.lastSnapshot : undefined,
    );
    const me = acked.state.players.get(session.playerId)!;
    const expectedMin = Math.min(start.x + PLAYER_SPEED * 20, ARENA_WIDTH - PLAYER_RADIUS);
    assert.ok(me.x >= expectedMin, `moved from ${start.x} to ${me.x}`);
    assert.equal(me.y, start.y);
    assert.equal(client.pendingInputs, 0);
    await until(() => client.rttMs);
    assert.ok(client.rttMs! >= 0 && client.rttMs! < 1000);
  } finally {
    client.leave();
    await t.stop();
  }
});

test("two clients share a room and see each other", async () => {
  const t = await startShooter();
  const a = new TickForgeClient<ShooterState, ShooterInput>(shooterCodec, { url: t.url, pingIntervalMs: 0 });
  const b = new TickForgeClient<ShooterState, ShooterInput>(shooterCodec, { url: t.url, pingIntervalMs: 0 });
  try {
    const sa = await a.connect({ name: "a" });
    const sb = await b.connect({ name: "b", roomId: sa.roomId });
    assert.equal(sb.roomId, sa.roomId);
    const seen: Snapshot<ShooterState>[] = [];
    a.onSnapshot = (s) => seen.push(s);
    await until(() => seen.find((s) => s.state.players.has(sb.playerId)));
    const ticks = seen.map((s) => s.tick);
    assert.deepEqual(ticks, [...ticks].sort((x, y) => x - y));
  } finally {
    a.leave();
    b.leave();
    await t.stop();
  }
});

test("token reconnect from a new client keeps the player id", async () => {
  const t = await startShooter();
  const first = new TickForgeClient<ShooterState, ShooterInput>(shooterCodec, { url: t.url, pingIntervalMs: 0 });
  const second = new TickForgeClient<ShooterState, ShooterInput>(shooterCodec, { url: t.url, pingIntervalMs: 0 });
  try {
    const s1 = await first.connect({ name: "p" });
    let closedWith: LeaveReason | undefined;
    first.onClose = (info) => {
      closedWith = info.leaveReason;
    };
    const s2 = await second.connect({ name: "p", token: s1.token });
    assert.equal(s2.playerId, s1.playerId);
    assert.equal(s2.token, s1.token);
    await until(() => (first.status === "closed" ? true : undefined));
    assert.equal(closedWith, LeaveReason.Replaced);
  } finally {
    second.leave();
    await t.stop();
  }
});

test("connect rejects with the server's error code", async () => {
  const t = await startShooter();
  const c = new TickForgeClient<ShooterState, ShooterInput>(shooterCodec, { url: t.url, pingIntervalMs: 0 });
  try {
    await assert.rejects(c.connect({ roomId: "does-not-exist" }), (err: unknown) => {
      assert.ok(err instanceof ConnectError);
      assert.equal(err.code, ErrorCode.RoomNotFound);
      return true;
    });
    await assert.rejects(c.connect(), /Cannot connect/);
  } finally {
    await t.stop();
  }
});

test("server shutdown is reported to the client", async () => {
  const t = await startShooter();
  const c = new TickForgeClient<ShooterState, ShooterInput>(shooterCodec, { url: t.url, pingIntervalMs: 0 });
  await c.connect();
  const closed = new Promise<LeaveReason | undefined>((resolve) => {
    c.onClose = (info) => resolve(info.leaveReason);
  });
  await t.stop();
  assert.equal(await closed, LeaveReason.ServerShutdown);
  assert.throws(() => c.sendInput({ buttons: 0 }), /closed/);
});

test("connecting to a dead port fails cleanly", async () => {
  const c = new TickForgeClient<ShooterState, ShooterInput>(shooterCodec, { url: "ws://127.0.0.1:1", pingIntervalMs: 0 });
  await assert.rejects(c.connect(), ConnectError);
  assert.equal(c.status, "closed");
});
