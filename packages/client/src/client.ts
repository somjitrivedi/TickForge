import {
  BinaryWriter,
  LeaveReason,
  MessageType,
  PROTOCOL_VERSION,
  decodeMessage,
  decodeWith,
  encodeMessage,
  encodeWith,
} from "@tickforge/protocol";
import type { ErrorCode, GameCodec, Message, WelcomeMessage } from "@tickforge/protocol";
import { resolveClientOptions } from "./options.ts";
import type { ClientOptions } from "./options.ts";

export const MAX_PENDING_INPUTS = 64;

export type ClientStatus = "idle" | "connecting" | "connected" | "closed";

export interface JoinParams {
  name?: string;
  roomId?: string;
  token?: string;
}

export interface Session {
  playerId: number;
  roomId: string;
  tickRate: number;
  joinTick: number;
  token: string;
}

export interface Snapshot<S> {
  tick: number;
  ackSeq: number;
  state: S;
}

export interface CloseInfo {
  serverError?: { code: ErrorCode; message: string };
  leaveReason?: LeaveReason;
  code: number;
  reason: string;
}

export class ConnectError extends Error {
  readonly code: ErrorCode | undefined;

  constructor(message: string, code?: ErrorCode) {
    super(message);
    this.name = "ConnectError";
    this.code = code;
  }
}

export type WebSocketFactory = (url: string) => WebSocket;

interface PendingInput {
  seq: number;
  bytes: Uint8Array;
}

export class TickForgeClient<S, I> {
  readonly options: ClientOptions;
  status: ClientStatus = "idle";
  session: Session | undefined;
  rttMs: number | undefined;
  lastSnapshot: Snapshot<S> | undefined;
  onSnapshot: (snapshot: Snapshot<S>) => void = () => {};
  onClose: (info: CloseInfo) => void = () => {};

  private readonly codec: GameCodec<S, I>;
  private readonly factory: WebSocketFactory;
  private socket: WebSocket | undefined;
  private nextSeq = 1;
  private pending: PendingInput[] = [];
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private nextNonce = 1;
  private readonly pings = new Map<number, number>();
  private readonly inputWriter = new BinaryWriter(64);
  private closeInfo: Partial<CloseInfo> = {};

  constructor(codec: GameCodec<S, I>, options: Partial<ClientOptions> & { url: string }, factory?: WebSocketFactory) {
    this.codec = codec;
    this.options = resolveClientOptions(options);
    this.factory = factory ?? ((url) => new WebSocket(url));
  }

  get pendingInputs(): number {
    return this.pending.length;
  }

  connect(params: JoinParams = {}): Promise<Session> {
    if (this.status !== "idle") return Promise.reject(new ConnectError(`Cannot connect while ${this.status}`));
    this.status = "connecting";
    return new Promise<Session>((resolve, reject) => {
      const socket = this.factory(this.options.url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      let settled = false;
      const settle = (err: Error | undefined, session?: Session) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(session!);
      };
      const timer = setTimeout(() => {
        settle(new ConnectError("Timed out waiting for welcome"));
        socket.close();
      }, this.options.connectTimeoutMs);

      socket.onopen = () => {
        this.sendRaw(
          encodeMessage({
            type: MessageType.Hello,
            version: PROTOCOL_VERSION,
            name: params.name ?? "",
            roomId: params.roomId ?? "",
            token: params.token ?? "",
          }),
        );
      };
      socket.onmessage = (ev: MessageEvent) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        let msg: Message;
        try {
          msg = decodeMessage(new Uint8Array(ev.data));
        } catch {
          socket.close(1008, "bad message from server");
          return;
        }
        if (msg.type === MessageType.Welcome) {
          const session = this.welcomed(msg, params.token ?? "");
          settle(undefined, session);
          return;
        }
        if (msg.type === MessageType.Error) {
          this.closeInfo.serverError = { code: msg.code, message: msg.message };
          settle(new ConnectError(msg.message, msg.code));
          return;
        }
        try {
          this.handle(msg);
        } catch {
          socket.close(1008, "bad payload from server");
        }
      };
      socket.onclose = (ev: CloseEvent) => {
        this.status = "closed";
        clearInterval(this.pingTimer);
        settle(new ConnectError(`Connection closed before welcome (${ev.code})`));
        this.onClose({ ...this.closeInfo, code: ev.code, reason: ev.reason });
      };
    });
  }

  sendInput(input: I): number {
    if (this.status !== "connected") throw new Error(`Cannot send input while ${this.status}`);
    const seq = this.nextSeq++;
    this.pending.push({ seq, bytes: encodeWith(this.codec.writeInput, input, this.inputWriter) });
    if (this.pending.length > MAX_PENDING_INPUTS) this.pending.splice(0, this.pending.length - MAX_PENDING_INPUTS);
    const window = this.pending.slice(-this.options.inputRedundancy);
    this.sendRaw(
      encodeMessage({ type: MessageType.Input, firstSeq: window[0]!.seq, inputs: window.map((p) => p.bytes) }),
    );
    return seq;
  }

  ping(): void {
    if (this.status !== "connected") return;
    const nonce = this.nextNonce++ >>> 0;
    const now = performance.now();
    this.pings.set(nonce, now);
    if (this.pings.size > 32) this.pings.delete(this.pings.keys().next().value!);
    this.sendRaw(encodeMessage({ type: MessageType.Ping, nonce, clientTime: now }));
  }

  leave(): void {
    if (this.status !== "connected" && this.status !== "connecting") return;
    this.closeInfo.leaveReason = LeaveReason.ClientLeft;
    this.sendRaw(encodeMessage({ type: MessageType.Leave, reason: LeaveReason.ClientLeft }));
    this.socket?.close(1000, "left");
  }

  private welcomed(msg: WelcomeMessage, sentToken: string): Session {
    this.status = "connected";
    this.session = {
      playerId: msg.playerId,
      roomId: msg.roomId,
      tickRate: msg.tickRate,
      joinTick: msg.tick,
      token: msg.token !== "" ? msg.token : sentToken,
    };
    if (this.options.pingIntervalMs > 0) {
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), this.options.pingIntervalMs);
    }
    return this.session;
  }

  private handle(msg: Message): void {
    switch (msg.type) {
      case MessageType.Snapshot: {
        const state = decodeWith(this.codec.readState, msg.state);
        let drop = 0;
        while (drop < this.pending.length && this.pending[drop]!.seq <= msg.ackSeq) drop++;
        if (drop > 0) this.pending.splice(0, drop);
        this.lastSnapshot = { tick: msg.tick, ackSeq: msg.ackSeq, state };
        this.onSnapshot(this.lastSnapshot);
        return;
      }
      case MessageType.Pong: {
        const sent = this.pings.get(msg.nonce);
        if (sent === undefined) return;
        this.pings.delete(msg.nonce);
        const sample = performance.now() - sent;
        this.rttMs = this.rttMs === undefined ? sample : this.rttMs * 0.875 + sample * 0.125;
        return;
      }
      case MessageType.Leave:
        this.closeInfo.leaveReason = msg.reason;
        return;
      default:
        return;
    }
  }

  private sendRaw(bytes: Uint8Array): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(bytes);
  }
}
