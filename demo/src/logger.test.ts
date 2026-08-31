import { Writable } from 'node:stream';
import { createLogger } from './logger';
import type pino from 'pino';

function capture(level?: string) {
  const prev = process.env.LOG_LEVEL;
  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  const lines: string[] = [];
  const logger = createLogger(
    new Writable({
      write(chunk: Buffer, _enc: unknown, cb: () => void) {
        lines.push(chunk.toString());
        cb();
      },
    }) as pino.DestinationStream,
  );
  if (prev === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = prev;
  return { lines, logger };
}

describe('Given a structured JSON logger', () => {
  it('only emits entries at or above the configured level', () => {
    const { lines, logger } = capture('warn');
    logger.info({ n: 1 }, 'below');
    logger.warn({ n: 2 }, 'at');
    logger.error({ n: 3 }, 'above');
    expect(lines).toHaveLength(2);
    const levels = lines.map((l) => JSON.parse(l).level);
    expect(levels).toEqual([40, 50]);
  });

  it('emits valid JSON with a timestamp, service identity, and context fields', () => {
    const { lines, logger } = capture('info');
    logger.info({ key: 'k', rule: 'r', ip: '10.0.0.1' }, 'request handled');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      level: 30,
      msg: 'request handled',
      service: 'rate-limiter-demo',
      key: 'k',
      rule: 'r',
      ip: '10.0.0.1',
    });
    expect(typeof entry.time).toBe('number');
  });
});