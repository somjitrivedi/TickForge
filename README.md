# TickForge

An authoritative real-time multiplayer game server engine in TypeScript. The server and the clients run the same deterministic simulation code.

**Status: early development.** Working today: the authoritative server with a fixed-step tick loop, the binary wire protocol, rooms with capacity limits, a WebSocket transport, SQLite persistence, and a client SDK that sends inputs and receives snapshots. Not built yet: client prediction, rollback netcode, lag compensation, matchmaking and multi-process room scaling.

## Requirements

- Node.js 22.18 or newer (TypeScript runs natively through type stripping; there is no build step)
- No native dependencies: SQLite is Node's built-in `node:sqlite`, WebSockets use the pure-JS `ws` package
- Run it from a clone of this repository. The packages are not published to npm, and they point at TypeScript source, which Node will not run from inside `node_modules`. A browser game needs a bundler to use `@tickforge/client`.

## Production notes

The server speaks plain `ws://`. Put it behind a TLS-terminating proxy and have clients connect with `wss://`, because the Welcome message carries the player's reconnect token.

## Quick start

```sh
npm install
npm run check     # typecheck + tests
npm run server    # demo shooter server on ws://0.0.0.0:7350, SQLite at data/tickforge.db
npm run bots -- --bots 12 --seconds 10    # headless bots against a running server
```

## Packages

| Package | Role |
|---|---|
| `@tickforge/sim` | Deterministic simulation core: `GameDefinition` contract, seeded PRNG, FNV-1a state hashing, headless runner |
| `@tickforge/protocol` | Binary reader/writer, message codecs, `GameCodec` contract, limits |
| `@tickforge/server` | Authoritative `GameServer`: fixed-step tick loop, rooms and room manager, WebSocket transport, SQLite store |
| `@tickforge/client` | `TickForgeClient`: hello/welcome, redundant input sending, snapshot acks, RTT; runs on any platform `WebSocket` |
| `@tickforge/demo` | Top-down arena shooter (integer world units), its codec, the runnable server and a bot swarm |

## Wire protocol (v1)

Every frame is a binary WebSocket message: one type byte, then little-endian fields. Strings and byte blobs are prefixed with a varuint length.

| Type | Direction | Body |
|---|---|---|
| 1 Hello | C to S | version u16, name, roomId (empty = auto-join), token (empty = new guest) |
| 2 Welcome | S to C | playerId u32, roomId, tick u32, tickRate u8, token (only for a new guest) |
| 3 Input | C to S | firstSeq u32, count, inputs (the last N unacked inputs, resent for loss tolerance) |
| 4 Snapshot | S to C | tick u32, ackSeq u32 (last input applied for this player), state |
| 5 Ping / 6 Pong | both | nonce u32, clientTime f64 (+ serverTick u32 on Pong) |
| 7 Leave | both | reason u8 |
| 8 Error | S to C | code u16, message; the server then closes the socket |

The server applies one queued input per player per tick and repeats the last input when the queue is empty. Each player's queue holds at most 8 inputs; the oldest are dropped first. Text frames, malformed frames, unknown types and game inputs the codec rejects all get the sender kicked.

## Persistence (SQLite)

`Store` uses `node:sqlite` in WAL mode, with migrations tracked in `PRAGMA user_version`.

| Table | Contents |
|---|---|
| `players` | guest identities; only the SHA-256 of each token is stored |
| `rooms` | id, game, seed, max players, open/closed, final tick |
| `room_sessions` | each join and leave, with a reason: left, disconnected, replaced, kicked, shutdown, room_error, server_restart |

On startup, rooms and sessions left open by a crash are closed with the reason `server_restart`.

## Server configuration

| Variable | Default | Range |
|---|---|---|
| `TICKFORGE_HOST` | `0.0.0.0` | any |
| `TICKFORGE_PORT` | `7350` | 1–65535 |
| `TICKFORGE_TICK_RATE` | `30` | 1–240 Hz |
| `TICKFORGE_MAX_ROOMS_PER_WORKER` | `64` | 1–10000 |
| `TICKFORGE_MAX_PLAYERS_PER_ROOM` | `16` | 1–1024 |
| `TICKFORGE_HELLO_TIMEOUT_MS` | `5000` | 100–60000 |
| `TICKFORGE_DB_PATH` | `data/tickforge.db` | file path or `:memory:` |

## Determinism rules

Game state uses integers only: no floating-point positions and no `Math.random`, `Math.sin` or `Date.now` inside `step`. Randomness comes from the seeded `RngState` stored in the game state, so cloning the state also clones the RNG. Each tick produces a state hash, and tests check that replays give identical hashes.
