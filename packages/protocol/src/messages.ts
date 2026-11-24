import { BinaryReader, BinaryWriter, ProtocolError } from "./binary.ts";

export const PROTOCOL_VERSION = 1;

export const MessageType = {
  Hello: 1,
  Welcome: 2,
  Input: 3,
  Snapshot: 4,
  Ping: 5,
  Pong: 6,
  Leave: 7,
  Error: 8,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const ErrorCode = {
  VersionMismatch: 1,
  BadMessage: 2,
  HelloTimeout: 3,
  RoomNotFound: 4,
  RoomFull: 5,
  ServerFull: 6,
  InvalidToken: 7,
  NotJoined: 8,
  AlreadyJoined: 9,
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const LeaveReason = {
  ClientLeft: 0,
  Replaced: 1,
  ServerShutdown: 2,
  Kicked: 3,
} as const;

export type LeaveReason = (typeof LeaveReason)[keyof typeof LeaveReason];

export const Limits = {
  nameBytes: 64,
  roomIdBytes: 64,
  tokenBytes: 128,
  errorBytes: 512,
  inputBytes: 256,
  inputsPerMessage: 16,
  stateBytes: 1 << 20,
} as const;

export interface HelloMessage {
  type: typeof MessageType.Hello;
  version: number;
  name: string;
  roomId: string;
  token: string;
}

export interface WelcomeMessage {
  type: typeof MessageType.Welcome;
  playerId: number;
  roomId: string;
  tick: number;
  tickRate: number;
  token: string;
}

export interface InputMessage {
  type: typeof MessageType.Input;
  firstSeq: number;
  inputs: Uint8Array[];
}

export interface SnapshotMessage {
  type: typeof MessageType.Snapshot;
  tick: number;
  ackSeq: number;
  state: Uint8Array;
}

export interface PingMessage {
  type: typeof MessageType.Ping;
  nonce: number;
  clientTime: number;
}

export interface PongMessage {
  type: typeof MessageType.Pong;
  nonce: number;
  clientTime: number;
  serverTick: number;
}

export interface LeaveMessage {
  type: typeof MessageType.Leave;
  reason: LeaveReason;
}

export interface ErrorMessage {
  type: typeof MessageType.Error;
  code: ErrorCode;
  message: string;
}

export type Message =
  | HelloMessage
  | WelcomeMessage
  | InputMessage
  | SnapshotMessage
  | PingMessage
  | PongMessage
  | LeaveMessage
  | ErrorMessage;

const MESSAGE_TYPES: ReadonlySet<number> = new Set(Object.values(MessageType));
const ERROR_CODES: ReadonlySet<number> = new Set(Object.values(ErrorCode));
const LEAVE_REASONS: ReadonlySet<number> = new Set(Object.values(LeaveReason));

export function isMessageType(value: number): value is MessageType {
  return MESSAGE_TYPES.has(value);
}

function checkLen(field: string, bytes: number, max: number): void {
  if (bytes > max) throw new ProtocolError(`${field} exceeds ${max} bytes`);
}

const utf8 = new TextEncoder();

export function encodeMessage(msg: Message, w: BinaryWriter = new BinaryWriter()): Uint8Array {
  w.reset().u8(msg.type);
  switch (msg.type) {
    case MessageType.Hello:
      checkLen("name", utf8.encode(msg.name).length, Limits.nameBytes);
      checkLen("roomId", utf8.encode(msg.roomId).length, Limits.roomIdBytes);
      checkLen("token", utf8.encode(msg.token).length, Limits.tokenBytes);
      w.u16(msg.version).string(msg.name).string(msg.roomId).string(msg.token);
      break;
    case MessageType.Welcome:
      w.u32(msg.playerId).string(msg.roomId).u32(msg.tick).u8(msg.tickRate).string(msg.token);
      break;
    case MessageType.Input:
      if (msg.inputs.length === 0 || msg.inputs.length > Limits.inputsPerMessage) {
        throw new ProtocolError(`Input message must carry 1-${Limits.inputsPerMessage} inputs`);
      }
      w.u32(msg.firstSeq).varuint(msg.inputs.length);
      for (const input of msg.inputs) {
        checkLen("input", input.length, Limits.inputBytes);
        w.bytes(input);
      }
      break;
    case MessageType.Snapshot:
      checkLen("state", msg.state.length, Limits.stateBytes);
      w.u32(msg.tick).u32(msg.ackSeq).bytes(msg.state);
      break;
    case MessageType.Ping:
      w.u32(msg.nonce).f64(msg.clientTime);
      break;
    case MessageType.Pong:
      w.u32(msg.nonce).f64(msg.clientTime).u32(msg.serverTick);
      break;
    case MessageType.Leave:
      w.u8(msg.reason);
      break;
    case MessageType.Error:
      w.u16(msg.code).string(msg.message.slice(0, Limits.errorBytes));
      break;
  }
  return w.finish();
}

export function decodeMessage(data: Uint8Array): Message {
  const r = new BinaryReader(data);
  const type = r.u8();
  let msg: Message;
  switch (type) {
    case MessageType.Hello:
      msg = {
        type,
        version: r.u16(),
        name: r.string(Limits.nameBytes),
        roomId: r.string(Limits.roomIdBytes),
        token: r.string(Limits.tokenBytes),
      };
      break;
    case MessageType.Welcome:
      msg = {
        type,
        playerId: r.u32(),
        roomId: r.string(Limits.roomIdBytes),
        tick: r.u32(),
        tickRate: r.u8(),
        token: r.string(Limits.tokenBytes),
      };
      break;
    case MessageType.Input: {
      const firstSeq = r.u32();
      const count = r.varuint();
      if (count === 0 || count > Limits.inputsPerMessage) {
        throw new ProtocolError(`Input count ${count} outside 1-${Limits.inputsPerMessage}`);
      }
      const inputs: Uint8Array[] = [];
      for (let i = 0; i < count; i++) inputs.push(r.bytes(Limits.inputBytes));
      msg = { type, firstSeq, inputs };
      break;
    }
    case MessageType.Snapshot:
      msg = { type, tick: r.u32(), ackSeq: r.u32(), state: r.bytes(Limits.stateBytes) };
      break;
    case MessageType.Ping:
      msg = { type, nonce: r.u32(), clientTime: r.f64() };
      break;
    case MessageType.Pong:
      msg = { type, nonce: r.u32(), clientTime: r.f64(), serverTick: r.u32() };
      break;
    case MessageType.Leave: {
      const reason = r.u8();
      if (!LEAVE_REASONS.has(reason)) throw new ProtocolError(`Unknown leave reason ${reason}`);
      msg = { type, reason: reason as LeaveReason };
      break;
    }
    case MessageType.Error: {
      const code = r.u16();
      if (!ERROR_CODES.has(code)) throw new ProtocolError(`Unknown error code ${code}`);
      msg = { type, code: code as ErrorCode, message: r.string(Limits.errorBytes * 4) };
      break;
    }
    default:
      throw new ProtocolError(`Unknown message type ${type}`);
  }
  r.end();
  return msg;
}
