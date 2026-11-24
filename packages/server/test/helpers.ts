import WebSocket from "ws";
import { decodeMessage, encodeMessage, ProtocolError } from "@tickforge/protocol";
import type { GameCodec, Message } from "@tickforge/protocol";
import type { GameDefinition, PlayerId } from "@tickforge/sim";
import { GameServer, Store, WebSocketTransport, silentLogger } from "@tickforge/server";
import type { Connection } from "@tickforge/server";

export interface CounterState {
  tick: number;
  totals: Map<PlayerId, number>;
}

export const counterGame: GameDefinition<CounterState, number> = {
  id: "counter",
  tickRate: 50,
  createState: () => ({ tick: 0, totals: new Map() }),
  addPlayer: (s, id) => void s.totals.set(id, 0),
  removePlayer: (s, id) => void s.totals.delete(id),
  step(s, inputs) {
    for (const [id, v] of inputs) s.totals.set(id, (s.totals.get(id) ?? 0) + v);
    s.tick++;
  },
  neutralInput: () => 0,
  cloneState: (s) => ({ tick: s.tick, totals: new Map(s.totals) }),
  hashState: (s) => s.tick,
};

export const counterCodec: GameCodec<CounterState, number> = {
  writeInput: (w, v) => void w.u8(v),
  readInput(r) {
    const v = r.u8();
    if (v > 9) throw new ProtocolError(`counter input ${v} > 9`);
    return v;
  },
  writeState(w, s) {
    w.u32(s.tick).varuint(s.totals.size);
    for (const [id, v] of s.totals) w.u32(id).u32(v);
  },
  readState(r) {
    const tick = r.u32();
    const n = r.varuint();
    const totals = new Map<PlayerId, number>();
    for (let i = 0; i < n; i++) totals.set(r.u32(), r.u32());
    return { tick, totals };
  },
};

export class FakeConn implements Connection {
  static nextId = 1;
  readonly id = FakeConn.nextId++;
  readonly remoteAddress = "test";
  readonly sent: Message[] = [];
  closed: { code: number; reason: string } | undefined;
  private messageHandler: (data: Uint8Array) => void = () => {};
  private closeHandler: () => void = () => {};

  send(data: Uint8Array): void {
    this.sent.push(decodeMessage(data));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.closeHandler();
  }

  onMessage(handler: (data: Uint8Array) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  deliver(msg: Message): void {
    this.messageHandler(encodeMessage(msg));
  }
}

export interface TestServer {
  server: GameServer<CounterState, number>;
  store: Store;
  url: string;
  stop(): Promise<void>;
}

export async function startTestServer(
  overrides: Partial<{ maxRoomsPerWorker: number; maxPlayersPerRoom: number; helloTimeoutMs: number; tickRate: number }> = {},
): Promise<TestServer> {
  const store = Store.open(":memory:");
  const transport = new WebSocketTransport({ host: "127.0.0.1", port: 0 });
  const server = new GameServer({
    game: counterGame,
    codec: counterCodec,
    config: { tickRate: 50, maxRoomsPerWorker: 4, maxPlayersPerRoom: 2, helloTimeoutMs: 300, ...overrides },
    transport,
    store,
    logger: silentLogger,
  });
  const port = await server.start();
  return {
    server,
    store,
    url: `ws://127.0.0.1:${port}`,
    async stop() {
      await server.stop();
      store.close();
    },
  };
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 2000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export class RawClient {
  readonly messages: Message[] = [];
  closed: { code: number; reason: string } | undefined;
  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.messages.push(decodeMessage(new Uint8Array(data)));
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  static open(url: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new RawClient(ws);
      ws.once("open", () => resolve(c));
      ws.once("error", reject);
    });
  }

  send(msg: Message): void {
    this.ws.send(encodeMessage(msg));
  }

  sendBytes(data: Uint8Array | string): void {
    this.ws.send(data);
  }

  next<T extends Message["type"]>(type: T, timeoutMs = 2000): Promise<Extract<Message, { type: T }>> {
    return waitFor(
      () => this.messages.find((m): m is Extract<Message, { type: T }> => m.type === type),
      timeoutMs,
      `message type ${type}`,
    );
  }

  waitClosed(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    return waitFor(() => this.closed, timeoutMs, "socket close");
  }

  close(): void {
    this.ws.close();
  }
}
