export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[tickforge] ${m}`),
  warn: (m) => console.warn(`[tickforge] ${m}`),
  error: (m, err) => console.error(`[tickforge] ${m}`, err ?? ""),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
