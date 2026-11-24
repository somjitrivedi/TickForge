import { test } from "node:test";
import assert from "node:assert/strict";
import { createRng, nextInt, runHeadless } from "@tickforge/sim";
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  Button,
  MAX_HP,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  movePlayer,
  shooter,
} from "@tickforge/demo";
import type { ShooterPlayer } from "@tickforge/demo";

function at(x: number, y: number): ShooterPlayer {
  return { id: 1, x, y, hp: MAX_HP };
}

test("cardinal movement uses full speed", () => {
  const p = at(50_000, 30_000);
  movePlayer(p, Button.Right);
  assert.deepEqual([p.x, p.y], [50_000 + PLAYER_SPEED, 30_000]);
  movePlayer(p, Button.Up);
  assert.deepEqual([p.x, p.y], [50_000 + PLAYER_SPEED, 30_000 - PLAYER_SPEED]);
});

test("diagonal movement is scaled with integer maths", () => {
  const p = at(50_000, 30_000);
  movePlayer(p, Button.Down | Button.Left);
  assert.deepEqual([p.x, p.y], [50_000 - 212, 30_000 + 212]);
});

test("opposing buttons cancel out", () => {
  const p = at(50_000, 30_000);
  movePlayer(p, Button.Left | Button.Right | Button.Up | Button.Down);
  assert.deepEqual([p.x, p.y], [50_000, 30_000]);
});

test("players are clamped inside the arena", () => {
  const p = at(PLAYER_RADIUS + 10, ARENA_HEIGHT - PLAYER_RADIUS - 10);
  movePlayer(p, Button.Left | Button.Down);
  assert.deepEqual([p.x, p.y], [PLAYER_RADIUS, ARENA_HEIGHT - PLAYER_RADIUS]);
});

test("spawns are inside the arena and seed-dependent", () => {
  const a = shooter.createState(1);
  const b = shooter.createState(2);
  for (const id of [1, 2, 3]) {
    shooter.addPlayer(a, id);
    shooter.addPlayer(b, id);
  }
  for (const p of a.players.values()) {
    assert.ok(p.x >= PLAYER_RADIUS && p.x <= ARENA_WIDTH - PLAYER_RADIUS);
    assert.ok(p.y >= PLAYER_RADIUS && p.y <= ARENA_HEIGHT - PLAYER_RADIUS);
  }
  assert.notEqual(shooter.hashState(a), shooter.hashState(b));
});

test("adding the same player twice throws", () => {
  const s = shooter.createState(1);
  shooter.addPlayer(s, 1);
  assert.throws(() => shooter.addPlayer(s, 1));
});

test("players with no input this tick stay put and tick advances", () => {
  const s = shooter.createState(5);
  shooter.addPlayer(s, 1);
  const before = { ...s.players.get(1)! };
  shooter.step(s, new Map());
  assert.deepEqual(s.players.get(1), before);
  assert.equal(s.tick, 1);
});

test("clone is deep and hashes equal", () => {
  const s = shooter.createState(3);
  shooter.addPlayer(s, 1);
  const c = shooter.cloneState(s);
  assert.equal(shooter.hashState(c), shooter.hashState(s));
  shooter.step(c, new Map([[1, { buttons: Button.Right }]]));
  assert.notEqual(shooter.hashState(c), shooter.hashState(s));
  assert.equal(s.tick, 0);
});

test("removed players disappear from state", () => {
  const s = shooter.createState(3);
  shooter.addPlayer(s, 1);
  shooter.addPlayer(s, 2);
  shooter.removePlayer(s, 1);
  assert.deepEqual([...s.players.keys()], [2]);
});

test("identical seeds and inputs produce identical hashes every tick", () => {
  const run = () => {
    const inputRng = createRng(4242);
    return runHeadless(shooter, {
      seed: 777,
      players: [1, 2, 3, 4],
      ticks: 900,
      inputFor: () => ({ buttons: nextInt(inputRng, 16) }),
    });
  };
  const a = run();
  const b = run();
  assert.equal(a.hashes.length, 900);
  assert.deepEqual(a.hashes, b.hashes);
  assert.equal(a.state.tick, 900);
});

test("resuming from a clone matches an uninterrupted run", () => {
  const inputs = (t: number, p: number) => ({ buttons: (t * 7 + p * 3) % 16 });
  const full = runHeadless(shooter, { seed: 9, players: [1, 2], ticks: 200, inputFor: inputs });

  const s = shooter.createState(9);
  shooter.addPlayer(s, 1);
  shooter.addPlayer(s, 2);
  const step = (state: typeof s, t: number) =>
    shooter.step(state, new Map([[1, inputs(t, 1)], [2, inputs(t, 2)]]));
  for (let t = 0; t < 100; t++) step(s, t);
  const resumed = shooter.cloneState(s);
  for (let t = 100; t < 200; t++) step(resumed, t);

  assert.equal(shooter.hashState(resumed), full.hashes[199]);
});
