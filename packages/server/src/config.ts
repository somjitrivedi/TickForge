export interface ServerConfig {
  host: string;
  port: number;
  tickRate: number;
  maxRoomsPerWorker: number;
  maxPlayersPerRoom: number;
  helloTimeoutMs: number;
  dbPath: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid server configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const DEFAULTS: ServerConfig = {
  host: "0.0.0.0",
  port: 7350,
  tickRate: 30,
  maxRoomsPerWorker: 64,
  maxPlayersPerRoom: 16,
  helloTimeoutMs: 5000,
  dbPath: "data/tickforge.db",
};

function readInt(env: Env, key: string, fallback: number, min: number, max: number, issues: string[]): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    issues.push(`${key} must be an integer in [${min}, ${max}], got "${raw}"`);
    return fallback;
  }
  return n;
}

export function loadConfig(env: Env): ServerConfig {
  const issues: string[] = [];
  const host = env["TICKFORGE_HOST"]?.trim() || DEFAULTS.host;
  const config: ServerConfig = {
    host,
    port: readInt(env, "TICKFORGE_PORT", DEFAULTS.port, 1, 65535, issues),
    tickRate: readInt(env, "TICKFORGE_TICK_RATE", DEFAULTS.tickRate, 1, 240, issues),
    maxRoomsPerWorker: readInt(env, "TICKFORGE_MAX_ROOMS_PER_WORKER", DEFAULTS.maxRoomsPerWorker, 1, 10000, issues),
    maxPlayersPerRoom: readInt(env, "TICKFORGE_MAX_PLAYERS_PER_ROOM", DEFAULTS.maxPlayersPerRoom, 1, 1024, issues),
    helloTimeoutMs: readInt(env, "TICKFORGE_HELLO_TIMEOUT_MS", DEFAULTS.helloTimeoutMs, 100, 60000, issues),
    dbPath: env["TICKFORGE_DB_PATH"]?.trim() || DEFAULTS.dbPath,
  };
  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

export function tickIntervalMs(config: Pick<ServerConfig, "tickRate">): number {
  return 1000 / config.tickRate;
}
