import { BinaryReader, BinaryWriter, MessageType, encodeMessage, encodeWith } from "@tickforge/protocol";
import type { GameCodec } from "@tickforge/protocol";
import type { GameDefinition, PlayerId } from "@tickforge/sim";
import type { Connection } from "./transport.ts";

export const MAX_QUEUED_INPUTS = 8;

interface QueuedInput<I> {
  seq: number;
  input: I;
}

export interface RoomPlayer<I> {
  readonly id: PlayerId;
  readonly name: string;
  readonly conn: Connection;
  readonly sessionId: number;
  queue: QueuedInput<I>[];
  lastReceivedSeq: number;
  lastProcessedSeq: number;
  lastInput: I;
  droppedInputs: number;
}

export interface JoiningPlayer {
  id: PlayerId;
  name: string;
  conn: Connection;
  sessionId: number;
}

export class Room<S, I> {
  readonly players = new Map<PlayerId, RoomPlayer<I>>();
  readonly state: S;
  tick = 0;
  closed = false;
  private readonly frameInputs = new Map<PlayerId, I>();
  private readonly stateWriter = new BinaryWriter(1024);
  private readonly messageWriter = new BinaryWriter(1024);
  readonly id: string;
  readonly game: GameDefinition<S, I>;
  readonly codec: GameCodec<S, I>;
  readonly maxPlayers: number;
  readonly seed: number;

  constructor(id: string, game: GameDefinition<S, I>, codec: GameCodec<S, I>, maxPlayers: number, seed: number) {
    this.id = id;
    this.game = game;
    this.codec = codec;
    this.maxPlayers = maxPlayers;
    this.seed = seed;
    this.state = game.createState(seed);
  }

  get size(): number {
    return this.players.size;
  }

  get isFull(): boolean {
    return this.players.size >= this.maxPlayers;
  }

  add(p: JoiningPlayer): void {
    if (this.closed) throw new Error(`Room ${this.id} is closed`);
    if (this.players.has(p.id)) throw new Error(`Player ${p.id} already in room ${this.id}`);
    if (this.isFull) throw new Error(`Room ${this.id} is full`);
    this.game.addPlayer(this.state, p.id);
    this.players.set(p.id, {
      ...p,
      queue: [],
      lastReceivedSeq: 0,
      lastProcessedSeq: 0,
      lastInput: this.game.neutralInput(),
      droppedInputs: 0,
    });
  }

  remove(id: PlayerId): RoomPlayer<I> | undefined {
    const p = this.players.get(id);
    if (!p) return undefined;
    this.players.delete(id);
    this.game.removePlayer(this.state, id);
    return p;
  }

  receiveInputs(id: PlayerId, firstSeq: number, raw: readonly Uint8Array[]): void {
    const p = this.players.get(id);
    if (!p) return;
    for (let i = 0; i < raw.length; i++) {
      const seq = firstSeq + i;
      if (seq <= p.lastReceivedSeq) continue;
      const r = new BinaryReader(raw[i]!);
      const input = this.codec.readInput(r);
      r.end();
      p.queue.push({ seq, input });
      p.lastReceivedSeq = seq;
    }
    const overflow = p.queue.length - MAX_QUEUED_INPUTS;
    if (overflow > 0) {
      p.queue.splice(0, overflow);
      p.droppedInputs += overflow;
    }
  }

  step(): void {
    this.frameInputs.clear();
    for (const p of this.players.values()) {
      const next = p.queue.shift();
      if (next) {
        p.lastInput = next.input;
        p.lastProcessedSeq = next.seq;
      }
      this.frameInputs.set(p.id, p.lastInput);
    }
    this.game.step(this.state, this.frameInputs);
    this.tick++;
  }

  broadcastSnapshot(): void {
    const state = encodeWith(this.codec.writeState, this.state, this.stateWriter);
    for (const p of this.players.values()) {
      p.conn.send(
        encodeMessage({ type: MessageType.Snapshot, tick: this.tick, ackSeq: p.lastProcessedSeq, state }, this.messageWriter),
      );
    }
  }
}
