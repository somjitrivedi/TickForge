export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class BinaryWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.pos;
  }

  reset(): this {
    this.pos = 0;
    return this;
  }

  private ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    checkInt(v, 0, 0xff, "u8");
    this.ensure(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }

  u16(v: number): this {
    checkInt(v, 0, 0xffff, "u16");
    this.ensure(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    checkInt(v, 0, 0xffffffff, "u32");
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  i32(v: number): this {
    checkInt(v, -0x80000000, 0x7fffffff, "i32");
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  f64(v: number): this {
    if (!Number.isFinite(v)) throw new ProtocolError(`f64 must be finite, got ${v}`);
    this.ensure(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  varuint(v: number): this {
    checkInt(v, 0, 0xffffffff, "varuint");
    this.ensure(5);
    let n = v;
    while (n >= 0x80) {
      this.buf[this.pos++] = (n & 0x7f) | 0x80;
      n >>>= 7;
    }
    this.buf[this.pos++] = n;
    return this;
  }

  bytes(data: Uint8Array): this {
    this.varuint(data.length);
    this.ensure(data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
    return this;
  }

  string(s: string): this {
    return this.bytes(encoder.encode(s));
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export class BinaryReader {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  private need(n: number, what: string): void {
    if (this.pos + n > this.data.length) {
      throw new ProtocolError(`Truncated message while reading ${what}`);
    }
  }

  u8(): number {
    this.need(1, "u8");
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    this.need(2, "u16");
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4, "u32");
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4, "i32");
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    this.need(8, "f64");
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    if (!Number.isFinite(v)) throw new ProtocolError("f64 is not finite");
    return v;
  }

  varuint(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = this.u8();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) {
        if (result > 0xffffffff) throw new ProtocolError("varuint exceeds 32 bits");
        return result;
      }
    }
    throw new ProtocolError("varuint is too long");
  }

  bytes(maxLength: number): Uint8Array {
    const len = this.varuint();
    if (len > maxLength) throw new ProtocolError(`Byte field of ${len} exceeds limit ${maxLength}`);
    this.need(len, "bytes");
    const out = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(maxBytes: number): string {
    const raw = this.bytes(maxBytes);
    try {
      return decoder.decode(raw);
    } catch {
      throw new ProtocolError("String is not valid UTF-8");
    }
  }

  end(): void {
    if (this.remaining !== 0) throw new ProtocolError(`${this.remaining} unexpected trailing bytes`);
  }
}

function checkInt(v: number, min: number, max: number, kind: string): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new ProtocolError(`${kind} out of range: ${v}`);
  }
}
