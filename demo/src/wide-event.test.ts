import { Writable } from 'node:stream';
import request from 'supertest';
import type pino from 'pino';
import type { Request } from 'express';
import {
  FailOpenStore,
  MemoryStore,
  type BucketRule,
  type Emitter,
  type Store,
} from 'rate-limiter';
import { createApp, makeStore } from './server';
import { createLogger } from './logger';
import { readConfig } from './config';

const config = readConfig(process.env);

const allRules: Array<BucketRule<Request>> = [
  { bucketOf: () => 'global', rule: { windowMs: 60_000, maxRequests: 10_000 } },
];

const defaultStoreFactory = (events?: Emitter): Store => makeStore(config, events);

function captureLines() {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'info',
    destination: new Writable({
      write(chunk: Buffer, _enc: unknown, cb: () => void) {
        lines.push(chunk.toString());
        cb();
      },
    }) as pino.DestinationStream,
  });
  return { lines, logger };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

describe('Given the wide-event request log', () => {
  it('writes one throttled wide event per request with rate-limit, IP, request, and user context', async () => {
    const { lines, logger } = captureLines();
    const rules: Array<BucketRule<Request>> = [
      { bucketOf: (req) => req.ip ?? 'unknown', rule: { windowMs: 60_000, maxRequests: 2 } },
    ];
    const app = createApp(rules, config, defaultStoreFactory, logger);

    const first = await request(app).get('/api/route').set('X-Forwarded-For', '10.0.0.1');
    expect(first.status).toBe(200);
    const second = await request(app)
      .get('/api/route')
      .set('X-Forwarded-For', '10.0.0.1')
      .set('X-Request-Id', 'req-2')
      .set('X-User-Id', 'user-2');
    expect(second.status).toBe(200);
    const throttled = await request(app)
      .get('/api/route')
      .set('X-Forwarded-For', '10.0.0.1')
      .set('X-Request-Id', 'req-3')
      .set('X-User-Id', 'user-3');
    expect(throttled.status).toBe(429);
    await flush();

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 30, status_code: 200 });
    expect(JSON.parse(lines[1])).toMatchObject({ level: 30, status_code: 200, request_id: 'req-2', user_id: 'user-2' });
    const entry = JSON.parse(lines[2]);
    expect(entry).toMatchObject({
      level: 40,
      msg: 'request throttled',
      status_code: 429,
      ip: '10.0.0.1',
      request_id: 'req-3',
      user_id: 'user-3',
    });
    expect(entry.rate_limit).toMatchObject({ allowed: false, bucket: '10.0.0.1', limit: 2, remaining: 0 });
    expect(typeof entry.rate_limit.retry_after).toBe('number');
    expect(entry.rate_limit.rule).toEqual({ window_ms: 60_000, max_requests: 2 });
  });

  it('logs an error-level wide event with a stack trace when the store fails', async () => {
    const { lines, logger } = captureLines();
    const failing: Store = {
      increment: () => Promise.reject(new Error('redis exploded')),
      get: () => Promise.reject(new Error('redis exploded')),
      reset: () => Promise.reject(new Error('redis exploded')),
      ping: () => Promise.resolve(true),
      close: () => Promise.resolve(),
    };
    const app = createApp(allRules, config, () => failing, logger);

    const res = await request(app).get('/api/route');
    expect(res.status).toBe(500);
    await flush();

    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ level: 50, msg: 'request errored', status_code: 500 });
    expect(entry.error).toMatchObject({ type: 'Error', message: 'redis exploded' });
    expect(entry.error.stack).toContain('redis exploded');
  });

  it('flags memory fallback on the wide event without a per-request log storm', async () => {
    const { lines, logger } = captureLines();
    const primary: Store = {
      increment: () => Promise.reject(new Error('redis down')),
      get: () => Promise.reject(new Error('redis down')),
      reset: () => Promise.reject(new Error('redis down')),
      ping: () => Promise.reject(new Error('redis down')),
      close: () => Promise.resolve(),
    };
    const storeFactory = (events?: Emitter): Store =>
      new FailOpenStore({
        primary,
        failureThreshold: 2,
        recoveryTimeoutMs: 60_000,
        successThreshold: 1,
        fallback: new MemoryStore(),
        warn: () => {},
        events,
      });
    const app = createApp(allRules, config, storeFactory, logger);

    const first = await request(app).get('/api/route');
    const second = await request(app).get('/api/route');
    const third = await request(app).get('/api/route');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    await flush();

    // One wide line per request: no per-serve storm.
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 30,
      status_code: 200,
      store: { served_from: 'memory', reason: 'error', error: 'redis down' },
    });
    // The tripping request's own failure still surfaces as a fallback, not a short-circuit.
    expect(JSON.parse(lines[1])).toMatchObject({
      level: 30,
      status_code: 200,
      store: { served_from: 'memory', reason: 'error', error: 'redis down' },
    });
    expect(JSON.parse(lines[2])).toMatchObject({
      level: 30,
      status_code: 200,
      store: { served_from: 'memory', reason: 'open' },
    });

    const snapshot = (await request(app).get('/metrics')).text;
    expect(snapshot).toMatch(/rate_limit_fallback_total\{reason="error"\} 2/);
    expect(snapshot).toMatch(/rate_limit_fallback_total\{reason="open"\} 1/);
  });
});