export interface ClientOptions {
  url: string;
  interpolationTicks: number;
  inputRedundancy: number;
  pingIntervalMs: number;
  connectTimeoutMs: number;
}

const DEFAULTS = {
  interpolationTicks: 2,
  inputRedundancy: 3,
  pingIntervalMs: 1000,
  connectTimeoutMs: 10_000,
} as const;

function intIn(name: string, v: number, min: number, max: number): number {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${v}`);
  }
  return v;
}

export function resolveClientOptions(options: Partial<ClientOptions> & { url: string }): ClientOptions {
  let parsed: URL;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new TypeError(`Invalid server url: "${options.url}"`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new TypeError(`Server url must use ws:// or wss://, got "${parsed.protocol}"`);
  }
  return {
    url: parsed.toString(),
    interpolationTicks: intIn("interpolationTicks", options.interpolationTicks ?? DEFAULTS.interpolationTicks, 0, 30),
    inputRedundancy: intIn("inputRedundancy", options.inputRedundancy ?? DEFAULTS.inputRedundancy, 1, 16),
    pingIntervalMs: intIn("pingIntervalMs", options.pingIntervalMs ?? DEFAULTS.pingIntervalMs, 0, 60_000),
    connectTimeoutMs: intIn("connectTimeoutMs", options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs, 100, 120_000),
  };
}
