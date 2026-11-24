export interface RngState {
  s: number;
}

const FALLBACK_SEED = 0x9e3779b9;

export function createRng(seed: number): RngState {
  const s = seed >>> 0;
  return { s: s === 0 ? FALLBACK_SEED : s };
}

export function nextU32(rng: RngState): number {
  let x = rng.s;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  rng.s = x >>> 0;
  return rng.s;
}

export function nextInt(rng: RngState, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
    throw new RangeError(`maxExclusive must be an integer in [1, 2^32], got ${maxExclusive}`);
  }
  return nextU32(rng) % maxExclusive;
}

export function nextRange(rng: RngState, min: number, max: number): number {
  return min + nextInt(rng, max - min + 1);
}
