import {
  ErrorCode,
  LeaveReason,
  MessageType,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeMessage,
  encodeMessage,
} from "@tickforge/protocol";
import type { GameCodec, HelloMessage, Message } from "@tickforge/protocol";
import type { GameDefinition, PlayerId } from "@tickforge/sim";
import { RoomManager } from "./room-manager.ts";
import type { Room } from "./room.ts";
import type { SessionEndReason, Store } from "./store.ts";
import { TickLoop } from "./tick-loop.ts";
import type { Scheduler } from "./tick-loop.ts";
import { CloseCode } from "./transport.ts";
import type { Connection, TransportServer } from "./transport.ts";
import { consoleLogger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { ServerConfig } from "./config.ts";

export interface GameServerOptions<S, I> {
  game: GameDefinition<S, I>;
  codec: GameCodec<S, I>;
  config: Pick<ServerConfig, "tickRate" | "maxRoomsPerWorker" | "maxPlayersPerRoom" | "helloTimeoutMs">;
  transport: TransportServer;
  store: Store;
  logger?: Logger;
  scheduler?: Scheduler;
  roomSeed?: () => number;
}

interface ClientSession {
  conn: Connection;
  playerId: PlayerId | undefined;
  helloTimer: NodeJS.Timeout | undefined;
  closed: boolean;
}

const MAX_TICK_FIELD = 0xffffffff;

export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 24);
  return cleaned === "" ? "Player" : cleaned;
}

export class GameServer<S, I> {
  readonly rooms: RoomManager<S, I>;
  readonly loop: TickLoop;
  private readonly sessions = new Set<ClientSession>();
  private readonly byPlayer = new Map<PlayerId, ClientSession>();
  private readonly log: Logger;
  private started = false;
  private readonly options: GameServerOptions<S, I>;

  constructor(options: GameServerOptions<S, I>) {
    this.options = options;
    this.log = options.logger ?? consoleLogger;
    this.rooms = new RoomManager(
      options.game,
      options.codec,
      options.store,
      {
        maxRooms: options.config.maxRoomsPerWorker,
        maxPlayersPerRoom: options.config.maxPlayersPerRoom,
        ...(options.roomSeed ? { seed: options.roomSeed } : {}),
      },
      this.log,
    );
    this.loop = new TickLoop({
      tickRate: options.config.tickRate,
      onTick: () => this.rooms.tickAll((room, err) => this.onRoomError(room, err)),
      onError: (err) => this.log.error("tick failed", err),
      ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    });
    options.transport.onConnection((conn) => this.accept(conn));
  }

  get connectedPlayers(): number {
    return this.byPlayer.size;
  }

  async start(): Promise<number> {
    if (this.started) throw new Error("GameServer already started");
    this.started = true;
    const recovered = this.options.store.recoverOrphans();
    if (recovered.rooms > 0 || recovered.sessions > 0) {
      this.log.warn(`closed ${recovered.rooms} orphaned rooms and ${recovered.sessions} sessions from a previous run`);
    }
    const port = await this.options.transport.listen();
    this.loop.start();
    return port;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.loop.stop();
    const bye = encodeMessage({ type: MessageType.Leave, reason: LeaveReason.ServerShutdown });
    for (const p of this.rooms.closeAll("shutdown")) {
      p.conn.send(bye);
      p.conn.close(CloseCode.GoingAway, "server shutdown");
    }
    for (const s of [...this.sessions]) s.conn.close(CloseCode.GoingAway, "server shutdown");
    await this.options.transport.close();
  }

  private accept(conn: Connection): void {
    const session: ClientSession = { conn, playerId: undefined, helloTimer: undefined, closed: false };
    this.sessions.add(session);
    session.helloTimer = setTimeout(() => {
      this.fail(session, ErrorCode.HelloTimeout, "No hello received in time");
    }, this.options.config.helloTimeoutMs);
    conn.onMessage((data) => this.receive(session, data));
    conn.onClose(() => this.disconnected(session));
  }

  private receive(session: ClientSession, data: Uint8Array): void {
    if (session.closed) return;
    let msg: Message;
    try {
      msg = decodeMessage(data);
    } catch (err) {
      this.fail(session, ErrorCode.BadMessage, err instanceof ProtocolError ? err.message : "Malformed message");
      return;
    }
    if (session.playerId === undefined) {
      if (msg.type !== MessageType.Hello) {
        this.fail(session, ErrorCode.NotJoined, "First message must be hello");
        return;
      }
      this.hello(session, msg);
      return;
    }
    switch (msg.type) {
      case MessageType.Input: {
        const room = this.rooms.roomOf(session.playerId);
        if (!room) return;
        try {
          room.receiveInputs(session.playerId, msg.firstSeq, msg.inputs);
        } catch (err) {
          this.fail(session, ErrorCode.BadMessage, err instanceof Error ? err.message : "Bad input");
        }
        return;
      }
      case MessageType.Ping: {
        const room = this.rooms.roomOf(session.playerId);
        session.conn.send(
          encodeMessage({
            type: MessageType.Pong,
            nonce: msg.nonce,
            clientTime: msg.clientTime,
            serverTick: Math.min(room?.tick ?? 0, MAX_TICK_FIELD),
          }),
        );
        return;
      }
      case MessageType.Leave:
        this.release(session, "left");
        session.conn.close(CloseCode.Normal, "left");
        return;
      case MessageType.Hello:
        this.fail(session, ErrorCode.AlreadyJoined, "Hello already received");
        return;
      default:
        this.fail(session, ErrorCode.BadMessage, `Unexpected message type ${msg.type} from client`);
    }
  }

  private hello(session: ClientSession, msg: HelloMessage): void {
    clearTimeout(session.helloTimer);
    session.helloTimer = undefined;
    if (msg.version !== PROTOCOL_VERSION) {
      this.fail(session, ErrorCode.VersionMismatch, `Server speaks protocol ${PROTOCOL_VERSION}, client sent ${msg.version}`);
      return;
    }
    const name = sanitizeName(msg.name);
    const store = this.options.store;
    let playerId: number;
    let issuedToken = "";
    if (msg.token !== "") {
      const id = store.authenticate(msg.token, name);
      if (id === null) {
        this.fail(session, ErrorCode.InvalidToken, "Unknown player token");
        return;
      }
      playerId = id;
    } else {
      const guest = store.createGuest(name);
      playerId = guest.playerId;
      issuedToken = guest.token;
    }

    const previous = this.byPlayer.get(playerId);
    if (previous) {
      this.release(previous, "replaced");
      previous.conn.send(encodeMessage({ type: MessageType.Leave, reason: LeaveReason.Replaced }));
      previous.conn.close(CloseCode.PolicyViolation, "replaced by a newer connection");
    }

    const result = this.rooms.join({ playerId, name, roomId: msg.roomId, conn: session.conn });
    if (!result.ok) {
      this.fail(session, result.code, result.message);
      return;
    }
    session.playerId = playerId;
    this.byPlayer.set(playerId, session);
    session.conn.send(
      encodeMessage({
        type: MessageType.Welcome,
        playerId,
        roomId: result.room.id,
        tick: result.room.tick,
        tickRate: this.options.config.tickRate,
        token: issuedToken,
      }),
    );
    this.log.info(`player ${playerId} (${name}) joined room ${result.room.id}`);
  }

  private release(session: ClientSession, reason: SessionEndReason): void {
    const id = session.playerId;
    if (id === undefined) return;
    session.playerId = undefined;
    if (this.byPlayer.get(id) === session) this.byPlayer.delete(id);
    this.rooms.leave(id, reason);
  }

  private fail(session: ClientSession, code: ErrorCode, message: string): void {
    if (session.closed) return;
    session.conn.send(encodeMessage({ type: MessageType.Error, code, message }));
    this.release(session, "kicked");
    session.conn.close(CloseCode.PolicyViolation, message.slice(0, 100));
  }

  private disconnected(session: ClientSession): void {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.helloTimer);
    this.release(session, "disconnected");
    this.sessions.delete(session);
  }

  private onRoomError(room: Room<S, I>, err: unknown): void {
    this.log.error(`room ${room.id} crashed at tick ${room.tick}; closing it`, err);
    const bye = encodeMessage({ type: MessageType.Leave, reason: LeaveReason.Kicked });
    for (const p of this.rooms.closeRoom(room, "room_error")) {
      const s = this.byPlayer.get(p.id);
      if (s) {
        s.playerId = undefined;
        this.byPlayer.delete(p.id);
      }
      p.conn.send(bye);
      p.conn.close(CloseCode.Normal, "room closed");
    }
  }
}
