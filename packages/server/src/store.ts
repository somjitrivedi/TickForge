import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export type SessionEndReason = "left" | "disconnected" | "replaced" | "shutdown" | "kicked" | "room_error" | "server_restart";

export type RoomStatus = "open" | "closed";

export interface PlayerRecord {
  id: number;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface RoomRecord {
  id: string;
  game: string;
  status: RoomStatus;
  seed: number;
  maxPlayers: number;
  createdAt: number;
  closedAt: number | null;
  finalTick: number | null;
}

export interface SessionRecord {
  id: number;
  roomId: string;
  playerId: number;
  joinedAt: number;
  leftAt: number | null;
  leaveReason: SessionEndReason | null;
}

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE players (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    game TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    seed INTEGER NOT NULL,
    max_players INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    final_tick INTEGER
  );
  CREATE INDEX rooms_status ON rooms (status);
  CREATE TABLE room_sessions (
    id INTEGER PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms (id),
    player_id INTEGER NOT NULL REFERENCES players (id),
    joined_at INTEGER NOT NULL,
    left_at INTEGER,
    leave_reason TEXT
  );
  CREATE INDEX room_sessions_room ON room_sessions (room_id);
  CREATE INDEX room_sessions_open ON room_sessions (left_at) WHERE left_at IS NULL;
  `,
];

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type Row = Record<string, unknown>;

function num(row: Row, key: string): number {
  return Number(row[key]);
}

function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  return v === null || v === undefined ? null : Number(v);
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  private constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  static open(path: string, clock: Clock = systemClock): Store {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    const store = new Store(db, clock);
    store.migrate();
    return store;
  }

  get schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as Row;
    return num(row, "user_version");
  }

  private migrate(): void {
    for (let v = this.schemaVersion; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  createGuest(name: string): { playerId: number; token: string } {
    const token = randomBytes(24).toString("base64url");
    const now = this.clock.now();
    const res = this.db
      .prepare("INSERT INTO players (token_hash, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run(hashToken(token), name, now, now);
    return { playerId: Number(res.lastInsertRowid), token };
  }

  authenticate(token: string, name: string): number | null {
    const row = this.db.prepare("SELECT id FROM players WHERE token_hash = ?").get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    const id = num(row, "id");
    this.db.prepare("UPDATE players SET name = ?, last_seen_at = ? WHERE id = ?").run(name, this.clock.now(), id);
    return id;
  }

  getPlayer(id: number): PlayerRecord | null {
    const row = this.db.prepare("SELECT * FROM players WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: num(row, "id"),
      name: String(row["name"]),
      createdAt: num(row, "created_at"),
      lastSeenAt: num(row, "last_seen_at"),
    };
  }

  createRoom(id: string, game: string, seed: number, maxPlayers: number): void {
    this.db
      .prepare("INSERT INTO rooms (id, game, status, seed, max_players, created_at) VALUES (?, ?, 'open', ?, ?, ?)")
      .run(id, game, seed, maxPlayers, this.clock.now());
  }

  closeRoom(id: string, finalTick: number): void {
    this.db
      .prepare("UPDATE rooms SET status = 'closed', closed_at = ?, final_tick = ? WHERE id = ? AND status = 'open'")
      .run(this.clock.now(), finalTick, id);
  }

  getRoom(id: string): RoomRecord | null {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row["id"]),
      game: String(row["game"]),
      status: row["status"] as RoomStatus,
      seed: num(row, "seed"),
      maxPlayers: num(row, "max_players"),
      createdAt: num(row, "created_at"),
      closedAt: numOrNull(row, "closed_at"),
      finalTick: numOrNull(row, "final_tick"),
    };
  }

  openSession(roomId: string, playerId: number): number {
    const res = this.db
      .prepare("INSERT INTO room_sessions (room_id, player_id, joined_at) VALUES (?, ?, ?)")
      .run(roomId, playerId, this.clock.now());
    return Number(res.lastInsertRowid);
  }

  closeSession(sessionId: number, reason: SessionEndReason): void {
    this.db
      .prepare("UPDATE room_sessions SET left_at = ?, leave_reason = ? WHERE id = ? AND left_at IS NULL")
      .run(this.clock.now(), reason, sessionId);
  }

  listSessions(roomId: string): SessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM room_sessions WHERE room_id = ? ORDER BY id").all(roomId) as Row[];
    return rows.map((row) => ({
      id: num(row, "id"),
      roomId: String(row["room_id"]),
      playerId: num(row, "player_id"),
      joinedAt: num(row, "joined_at"),
      leftAt: numOrNull(row, "left_at"),
      leaveReason: (row["leave_reason"] as SessionEndReason | null) ?? null,
    }));
  }

  recoverOrphans(): { rooms: number; sessions: number } {
    return this.transaction(() => {
      const now = this.clock.now();
      const sessions = this.db
        .prepare("UPDATE room_sessions SET left_at = ?, leave_reason = 'server_restart' WHERE left_at IS NULL")
        .run(now);
      const rooms = this.db.prepare("UPDATE rooms SET status = 'closed', closed_at = ? WHERE status = 'open'").run(now);
      return { rooms: Number(rooms.changes), sessions: Number(sessions.changes) };
    });
  }

  close(): void {
    this.db.close();
  }
}
