import { BinaryReader, BinaryWriter } from "./binary.ts";

export interface GameCodec<S, I> {
  writeInput(w: BinaryWriter, input: I): void;
  readInput(r: BinaryReader): I;
  writeState(w: BinaryWriter, state: S): void;
  readState(r: BinaryReader): S;
}

export function encodeWith<T>(write: (w: BinaryWriter, value: T) => void, value: T, w = new BinaryWriter()): Uint8Array {
  w.reset();
  write(w, value);
  return w.finish();
}

export function decodeWith<T>(read: (r: BinaryReader) => T, data: Uint8Array): T {
  const r = new BinaryReader(data);
  const value = read(r);
  r.end();
  return value;
}
