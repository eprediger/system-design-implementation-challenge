import request from 'supertest';
import type { Request } from 'express';
import type { BucketRule, Emitter } from 'rate-limiter';
import { createMetrics, timedStore } from './metrics';
import { createApp, makeStore } from './server';
import { createLogger } from './logger';
import { readConfig } from './config';

const config = readConfig(process.env);
const storeFactory = (events?: Emitter) => makeStore(config, events);
const logger = createLogger({ level: 'silent' });

describe('Given the prometheus registry based metrics', () => {
  it('counters increment and allowed/throttled are tracked separately', async () => {
    const m = createMetrics();
    m.requestsTotal.inc({ rule: 'global' });
    m.requestsTotal.inc({ rule: 'global' });
    m.allowedTotal.inc({ rule: 'global' });
    m.throttledTotal.inc({ rule: 'global' });
    const snapshot = await m.registry.metrics();
    expect(snapshot).toContain('rate_limit_requests_total{rule="global"} 2');
    expect(snapshot).toContain('rate_limit_allowed_total{rule="global"} 1');
    expect(snapshot).toContain('rate_limit_throttled_total{rule="global"} 1');
  });

  it('histograms record values and expose p50, p95, and p99 quantiles', async () => {
    const m = createMetrics();
    for (let i = 1; i <= 100; i++) m.checkMs.observe(i);
    m.storeOpMs.observe({ operation: 'increment' }, 7);
    m.storeOpMs.observe({ operation: 'get' }, 3);
    const snapshot = await m.registry.metrics();
    expect(snapshot).toContain('rate_limit_check_ms_count 100');
    expect(snapshot).toMatch(/rate_limit_check_ms\{quantile="0.5"\} 5[0-1](\.\d+)?/);
    expect(snapshot).toMatch(/rate_limit_check_ms\{quantile="0.95"\} 9[5-6](\.\d+)?/);
    expect(snapshot).toMatch(/rate_limit_check_ms\{quantile="0.99"\} 9[9](\.\d+)?/);
    expect(snapshot).toContain('rate_limit_store_op_ms_count{operation="increment"} 1');
    expect(snapshot).toMatch(/rate_limit_store_op_ms_sum\{operation="get"\} 3/);
  });

  it('counters reset back to zero', async () => {
    const m = createMetrics();
    m.requestsTotal.inc();
    m.requestsTotal.reset();
    const snapshot = await m.registry.metrics();
    expect(snapshot).toMatch(/rate_limit_requests_total/);
  });

  it('the timed store decorator feeds the store-operation histogram', async () => {
    const m = createMetrics();
    const calls: string[] = [];
    const store = timedStore(
      {
        increment: async () => {
          calls.push('increment');
          return { current: 1, previous: 0 };
        },
        get: async () => {
          calls.push('get');
          return 1;
        },
        reset: async () => {
          calls.push('reset');
        },
        ping: async () => {
          calls.push('ping');
          return true;
        },
        close: async () => {},
      },
      m.storeOpMs,
    );
    await store.increment('k', 60_000, 1);
    await store.get('k', 60_000, 1);
    await store.reset('k');
    await store.ping();
    expect(calls).toEqual(['increment', 'get', 'reset', 'ping']);
    const snapshot = await m.registry.metrics();
    expect(snapshot).toMatch(/rate_limit_store_op_ms_count\{operation="increment"\} 1/);
    expect(snapshot).toMatch(/rate_limit_store_op_ms_count\{operation="get"\} 1/);
    expect(snapshot).toMatch(/rate_limit_store_op_ms_count\{operation="reset"\} 1/);
    expect(snapshot).toMatch(/rate_limit_store_op_ms_count\{operation="ping"\} 1/);
  });

  it('serves a live snapshot of the request flow through the app after 100 requests', async () => {
    const rules: Array<BucketRule<Request>> = [
      { bucketOf: () => 'all', rule: { windowMs: 60_000, maxRequests: 10_000 } },
    ];
    const app = createApp(rules, config, storeFactory, logger);
    for (let i = 0; i < 100; i++) {
      const res = await request(app).get('/api/route');
      expect(res.status).toBe(200);
    }
    const snapshot = (await request(app).get('/metrics')).text;
    expect(snapshot).toContain('rate_limit_requests_total{rule="global"} 100');
    expect(snapshot).toContain('rate_limit_allowed_total{rule="global"} 100');
    expect(snapshot).toMatch(/rate_limit_throttled_total/);
    expect(snapshot).toContain('rate_limit_check_ms_count 100');
  });
});