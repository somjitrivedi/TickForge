import { ConfigError, GameServer, Store, WebSocketTransport, consoleLogger, loadConfig } from "@tickforge/server";
import { shooterCodec } from "./codec.ts";
import { shooter } from "./shooter.ts";

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const store = Store.open(config.dbPath);
const transport = new WebSocketTransport({ host: config.host, port: config.port });
const server = new GameServer({ game: shooter, codec: shooterCodec, config, transport, store, logger: consoleLogger });

const port = await server.start();
consoleLogger.info(
  `${shooter.id} listening on ws://${config.host}:${port} at ${config.tickRate}Hz, db ${config.dbPath}, ` +
    `up to ${config.maxRoomsPerWorker} rooms x ${config.maxPlayersPerRoom} players`,
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  consoleLogger.info(`${signal} received, shutting down`);
  await server.stop();
  store.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
