import pino from 'pino';

export type AppLogger = pino.Logger;

/** Structured JSON logger; level filters via `LOG_LEVEL` (info default). */
export function createLogger(destination?: pino.DestinationStream): AppLogger {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      base: { service: 'rate-limiter-demo', version: '1.0.0' },
    },
    destination,
  );
}