import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { RedisStore, type BucketRule, type Store } from 'rate-limiter';
import { createApp } from './server';
import { redisAvailable } from '../jest/redis-available';

const describeRedis = redisAvailable ? describe : describe.skip;

const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const perIp: BucketRule<Request> = {
  bucketOf: (req) => req.ip ?? 'unknown',
  rule: { windowMs: 60_000, maxRequests: 100 },
};

describeRedis('Given two server instances sharing one Redis', () => {
  it('enforces the per-client ceiling globally across both instances', async () => {
    const token = `stress-${randomUUID()}.invalid`;
    const stores: Store[] = [];
    const storeFactory = (): Store => {
      const store = new RedisStore(url);
      stores.push(store);
      return store;
    };
    const apps = [createApp([perIp], storeFactory), createApp([perIp], storeFactory)];

    try {
      const responses = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          request(apps[i % 2]).get('/api/route').set('X-Forwarded-For', token),
        ),
      );

      const allowed = responses.filter((r) => r.status === 200);
      const throttled = responses.filter((r) => r.status === 429);
      expect(allowed).toHaveLength(100);
      expect(throttled).toHaveLength(100);

      const remaining = allowed.map((r) => Number(r.headers['x-ratelimit-remaining']));
      remaining.sort((a, b) => a - b);
      expect(remaining).toEqual(Array.from({ length: 100 }, (_, i) => i));
    } finally {
      await Promise.all(stores.map((store) => store.close()));
    }
  });
});