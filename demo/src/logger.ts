import pino from 'pino';
import type { LogLevel } from './config';

export type AppLogger = pino.Logger;

/** Structured JSON logger at a pre-validated level. */
export function createLogger(options: { level: LogLevel; destination?: pino.DestinationStream }): AppLogger {
  return pino(
    {
      level: options.level,
      base: { service: 'rate-limiter-demo', version: '1.0.0' },
    },
    options.destination,
  );
}
