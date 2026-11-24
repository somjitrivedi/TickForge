import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { CloseCode } from "./transport.ts";
import type { Connection, TransportServer } from "./transport.ts";

export interface WebSocketTransportOptions {
  host: string;
  port: number;
  maxMessageBytes?: number;
  maxBufferedBytes?: number;
  heartbeatMs?: number;
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

class WsConnection implements Connection {
  alive = true;
  private closed = false;
  private messageHandler: (data: Uint8Array) => void = () => {};
  private closeHandler: () => void = () => {};
  readonly id: number;
  readonly remoteAddress: string;
  private readonly socket: WebSocket;
  private readonly maxBufferedBytes: number;

  constructor(id: number, remoteAddress: string, socket: WebSocket, maxBufferedBytes: number) {
    this.id = id;
    this.remoteAddress = remoteAddress;
    this.socket = socket;
    this.maxBufferedBytes = maxBufferedBytes;
    socket.on("message", (data, isBinary) => {
      if (this.closed) return;
      if (!isBinary) {
        this.close(CloseCode.UnsupportedData, "binary frames only");
        return;
      }
      this.messageHandler(toBytes(data));
    });
    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler();
  }

  send(data: Uint8Array): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    if (this.socket.bufferedAmount > this.maxBufferedBytes) {
      this.close(CloseCode.TryAgainLater, "send buffer overflow");
      return;
    }
    this.socket.send(data, { binary: true });
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      this.socket.close(code, reason);
    }
    this.finish();
  }

  terminate(): void {
    this.socket.terminate();
    this.finish();
  }

  ping(): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.ping();
  }

  onMessage(handler: (data: Uint8Array) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
}

export class WebSocketTransport implements TransportServer {
  private wss: WebSocketServer | undefined;
  private handler: (conn: Connection) => void = () => {};
  private nextId = 1;
  private readonly connections = new Set<WsConnection>();
  private heartbeat: NodeJS.Timeout | undefined;

  private readonly options: WebSocketTransportOptions;

  constructor(options: WebSocketTransportOptions) {
    this.options = options;
  }

  onConnection(handler: (conn: Connection) => void): void {
    this.handler = handler;
  }

  listen(): Promise<number> {
    if (this.wss) return Promise.reject(new Error("Transport already listening"));
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.options.host,
        port: this.options.port,
        maxPayload: this.options.maxMessageBytes ?? 8192,
        perMessageDeflate: false,
      });
      this.wss = wss;
      wss.once("error", reject);
      wss.once("listening", () => {
        wss.off("error", reject);
        const addr = wss.address();
        resolve(addr === null || typeof addr === "string" ? this.options.port : addr.port);
      });
      wss.on("connection", (socket, req) => {
        const conn = new WsConnection(
          this.nextId++,
          req.socket.remoteAddress ?? "unknown",
          socket,
          this.options.maxBufferedBytes ?? 1 << 20,
        );
        this.connections.add(conn);
        socket.once("close", () => this.connections.delete(conn));
        this.handler(conn);
      });
      const heartbeatMs = this.options.heartbeatMs ?? 10_000;
      this.heartbeat = setInterval(() => {
        for (const c of this.connections) {
          if (!c.alive) {
            c.terminate();
            this.connections.delete(c);
            continue;
          }
          c.alive = false;
          c.ping();
        }
      }, heartbeatMs);
      this.heartbeat.unref();
    });
  }

  close(): Promise<void> {
    clearInterval(this.heartbeat);
    const wss = this.wss;
    this.wss = undefined;
    for (const c of this.connections) c.terminate();
    this.connections.clear();
    if (!wss) return Promise.resolve();
    return new Promise((resolve) => wss.close(() => resolve()));
  }
}
