import { test } from "node:test";
import assert from "node:assert/strict";
import { TickLoop } from "@tickforge/server";
import type { Scheduler } from "@tickforge/server";

class ManualScheduler implements Scheduler {
  time = 0;
  private task: { at: number; fn: () => void } | undefined;

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.task = { at: this.time + ms, fn };
    return this.task;
  }

  clearTimeout(handle: unknown): void {
    if (this.task === handle) this.task = undefined;
  }

  get pending(): boolean {
    return this.task !== undefined;
  }

  advanceTo(t: number): void {
    while (this.task && this.task.at <= t) {
      const task = this.task;
      this.task = undefined;
      this.time = Math.max(this.time, task.at);
      task.fn();
    }
    this.time = t;
  }
}

test("ticks at the configured rate", () => {
  const s = new ManualScheduler();
  let ticks = 0;
  const loop = new TickLoop({ tickRate: 50, onTick: () => ticks++, scheduler: s });
  loop.start();
  s.advanceTo(1000);
  assert.equal(ticks, 50);
  assert.equal(loop.stats.ticks, 50);
  assert.equal(loop.stats.droppedTicks, 0);
});

test("non-integer intervals do not drift", () => {
  const s = new ManualScheduler();
  let ticks = 0;
  const loop = new TickLoop({ tickRate: 30, onTick: () => ticks++, scheduler: s });
  loop.start();
  s.advanceTo(10_001);
  assert.equal(ticks, 300);
  s.advanceTo(100_001);
  assert.equal(ticks, 3000);
});

test("a late wakeup catches up, capped, and counts dropped ticks", () => {
  const s = new ManualScheduler();
  let ticks = 0;
  const loop = new TickLoop({ tickRate: 100, maxCatchUpTicks: 3, onTick: () => ticks++, scheduler: s });
  loop.start();
  s.time = 105;
  s.advanceTo(105);
  assert.equal(ticks, 3);
  assert.equal(loop.stats.droppedTicks, 7);
  s.advanceTo(115);
  assert.equal(ticks, 4);
});

test("onTick errors are reported and the loop keeps running", () => {
  const s = new ManualScheduler();
  const errors: unknown[] = [];
  let ticks = 0;
  const loop = new TickLoop({
    tickRate: 10,
    onTick: () => {
      ticks++;
      if (ticks === 2) throw new Error("boom");
    },
    onError: (e) => errors.push(e),
    scheduler: s,
  });
  loop.start();
  s.advanceTo(500);
  assert.equal(ticks, 5);
  assert.equal(errors.length, 1);
});

test("stop cancels the pending wakeup and start is idempotent", () => {
  const s = new ManualScheduler();
  let ticks = 0;
  const loop = new TickLoop({ tickRate: 10, onTick: () => ticks++, scheduler: s });
  loop.start();
  loop.start();
  s.advanceTo(250);
  loop.stop();
  assert.equal(loop.running, false);
  assert.equal(s.pending, false);
  s.advanceTo(1000);
  assert.equal(ticks, 2);
});

test("rejects invalid tick rates", () => {
  assert.throws(() => new TickLoop({ tickRate: 0, onTick: () => {} }), RangeError);
  assert.throws(() => new TickLoop({ tickRate: 2.5, onTick: () => {} }), RangeError);
});
