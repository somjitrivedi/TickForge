export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface TickLoopOptions {
  tickRate: number;
  onTick: () => void;
  onError?: (err: unknown) => void;
  maxCatchUpTicks?: number;
  scheduler?: Scheduler;
}

export interface TickLoopStats {
  ticks: number;
  droppedTicks: number;
  lastTickMs: number;
  maxTickMs: number;
}

export class TickLoop {
  readonly intervalMs: number;
  private readonly maxCatchUp: number;
  private readonly s: Scheduler;
  private nextTickAt = 0;
  private handle: unknown;
  private active = false;
  readonly stats: TickLoopStats = { ticks: 0, droppedTicks: 0, lastTickMs: 0, maxTickMs: 0 };

  private readonly options: TickLoopOptions;

  constructor(options: TickLoopOptions) {
    this.options = options;
    if (!Number.isInteger(options.tickRate) || options.tickRate < 1) {
      throw new RangeError(`tickRate must be a positive integer, got ${options.tickRate}`);
    }
    this.intervalMs = 1000 / options.tickRate;
    this.maxCatchUp = options.maxCatchUpTicks ?? 5;
    this.s = options.scheduler ?? realScheduler;
  }

  get running(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.nextTickAt = this.s.now() + this.intervalMs;
    this.schedule();
  }

  stop(): void {
    this.active = false;
    if (this.handle !== undefined) this.s.clearTimeout(this.handle);
    this.handle = undefined;
  }

  private schedule(): void {
    const delay = Math.max(0, this.nextTickAt - this.s.now());
    this.handle = this.s.setTimeout(this.run, delay);
  }

  private readonly run = (): void => {
    this.handle = undefined;
    if (!this.active) return;
    const now = this.s.now();
    let ran = 0;
    while (this.active && now >= this.nextTickAt && ran < this.maxCatchUp) {
      const started = this.s.now();
      try {
        this.options.onTick();
      } catch (err) {
        this.options.onError?.(err);
      }
      const took = this.s.now() - started;
      this.stats.lastTickMs = took;
      if (took > this.stats.maxTickMs) this.stats.maxTickMs = took;
      this.stats.ticks++;
      this.nextTickAt += this.intervalMs;
      ran++;
    }
    if (now >= this.nextTickAt) {
      const behind = Math.floor((now - this.nextTickAt) / this.intervalMs) + 1;
      this.stats.droppedTicks += behind;
      this.nextTickAt += behind * this.intervalMs;
    }
    if (this.active) this.schedule();
  };
}
