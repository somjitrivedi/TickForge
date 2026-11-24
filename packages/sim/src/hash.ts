const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export class Hasher {
  private h = FNV_OFFSET;

  int(value: number): this {
    if (!Number.isInteger(value)) {
      throw new TypeError(`Hasher.int expects an integer, got ${value}`);
    }
    let v = value | 0;
    for (let i = 0; i < 4; i++) {
      this.h = Math.imul(this.h ^ (v & 0xff), FNV_PRIME);
      v >>>= 8;
    }
    return this;
  }

  digest(): number {
    return this.h >>> 0;
  }
}

export function hashInts(values: Iterable<number>): number {
  const h = new Hasher();
  for (const v of values) h.int(v);
  return h.digest();
}
