import { randomBytes, randomInt } from "node:crypto";
import { ErrorCode } from "@tickforge/protocol";
import type { GameCodec } from "@tickforge/protocol";
import type { GameDefinition, PlayerId } from "@tickforge/sim";
import { Room } from "./room.ts";
import type { JoiningPlayer, RoomPlayer } from "./room.ts";
import type { SessionEndReason, Store } from "./store.ts";
import type { Logger } from "./logger.ts";

export interface RoomManagerOptions {
  maxRooms: number;
  maxPlayersPerRoom: number;
  seed?: () => number;
  roomId?: () => string;
}

export interface JoinRequest {
  playerId: PlayerId;
  name: string;
  roomId: string;
  conn: JoiningPlayer["conn"];
}

export type JoinResult<S, I> = { ok: true; room: Room<S, I> } | { ok: false; code: ErrorCode; message: string };

export class RoomManager<S, I> {
  readonly rooms = new Map<string, Room<S, I>>();
  private readonly playerRoom = new Map<PlayerId, Room<S, I>>();
  private readonly nextSeed: () => number;
  private readonly nextRoomId: () => string;
  private readonly game: GameDefinition<S, I>;
  private readonly codec: GameCodec<S, I>;
  private readonly store: Store;
  private readonly options: RoomManagerOptions;
  private readonly log: Logger;

  constructor(game: GameDefinition<S, I>, codec: GameCodec<S, I>, store: Store, options: RoomManagerOptions, log: Logger) {
    this.game = game;
    this.codec = codec;
    this.store = store;
    this.options = options;
    this.log = log;
    this.nextSeed = options.seed ?? (() => randomInt(1, 0x7fffffff));
    this.nextRoomId = options.roomId ?? (() => randomBytes(6).toString("base64url"));
  }

  get playerCount(): number {
    return this.playerRoom.size;
  }

  roomOf(playerId: PlayerId): Room<S, I> | undefined {
    return this.playerRoom.get(playerId);
  }

  join(req: JoinRequest): JoinResult<S, I> {
    if (this.playerRoom.has(req.playerId)) {
      return { ok: false, code: ErrorCode.AlreadyJoined, message: "Player is already in a room" };
    }
    let room: Room<S, I> | undefined;
    if (req.roomId !== "") {
      room = this.rooms.get(req.roomId);
      if (!room) return { ok: false, code: ErrorCode.RoomNotFound, message: `Room ${req.roomId} not found` };
      if (room.isFull) return { ok: false, code: ErrorCode.RoomFull, message: `Room ${req.roomId} is full` };
    } else {
      room = this.findOpenRoom() ?? this.createRoom();
      if (!room) return { ok: false, code: ErrorCode.ServerFull, message: "No room capacity left on this server" };
    }
    const sessionId = this.store.openSession(room.id, req.playerId);
    try {
      room.add({ id: req.playerId, name: req.name, conn: req.conn, sessionId });
    } catch (err) {
      this.store.closeSession(sessionId, "room_error");
      throw err;
    }
    this.playerRoom.set(req.playerId, room);
    return { ok: true, room };
  }

  leave(playerId: PlayerId, reason: SessionEndReason): RoomPlayer<I> | undefined {
    const room = this.playerRoom.get(playerId);
    if (!room) return undefined;
    this.playerRoom.delete(playerId);
    const p = room.remove(playerId);
    if (p) this.store.closeSession(p.sessionId, reason);
    if (room.size === 0) this.closeRoom(room, reason);
    return p;
  }

  tickAll(onRoomError: (room: Room<S, I>, err: unknown) => void): void {
    for (const room of this.rooms.values()) {
      try {
        room.step();
        room.broadcastSnapshot();
      } catch (err) {
        onRoomError(room, err);
      }
    }
  }

  closeRoom(room: Room<S, I>, reason: SessionEndReason): RoomPlayer<I>[] {
    if (room.closed) return [];
    const evicted: RoomPlayer<I>[] = [];
    for (const id of [...room.players.keys()]) {
      const p = room.remove(id);
      this.playerRoom.delete(id);
      if (p) {
        this.store.closeSession(p.sessionId, reason);
        evicted.push(p);
      }
    }
    room.closed = true;
    this.rooms.delete(room.id);
    this.store.closeRoom(room.id, room.tick);
    this.log.info(`room ${room.id} closed at tick ${room.tick} (${reason})`);
    return evicted;
  }

  closeAll(reason: SessionEndReason): RoomPlayer<I>[] {
    const evicted: RoomPlayer<I>[] = [];
    for (const room of [...this.rooms.values()]) evicted.push(...this.closeRoom(room, reason));
    return evicted;
  }

  private findOpenRoom(): Room<S, I> | undefined {
    let best: Room<S, I> | undefined;
    for (const room of this.rooms.values()) {
      if (room.isFull) continue;
      if (!best || room.size > best.size) best = room;
    }
    return best;
  }

  private createRoom(): Room<S, I> | undefined {
    if (this.rooms.size >= this.options.maxRooms) return undefined;
    let id = this.nextRoomId();
    while (this.rooms.has(id)) id = this.nextRoomId();
    const seed = this.nextSeed();
    this.store.createRoom(id, this.game.id, seed, this.options.maxPlayersPerRoom);
    const room = new Room(id, this.game, this.codec, this.options.maxPlayersPerRoom, seed);
    this.rooms.set(id, room);
    this.log.info(`room ${id} created (seed ${seed})`);
    return room;
  }
}
