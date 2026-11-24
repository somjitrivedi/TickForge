export interface Connection {
  readonly id: number;
  readonly remoteAddress: string;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
  onMessage(handler: (data: Uint8Array) => void): void;
  onClose(handler: () => void): void;
}

export interface TransportServer {
  onConnection(handler: (conn: Connection) => void): void;
  listen(): Promise<number>;
  close(): Promise<void>;
}

export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  UnsupportedData: 1003,
  PolicyViolation: 1008,
  TryAgainLater: 1013,
} as const;
