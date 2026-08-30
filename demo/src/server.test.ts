import request from 'supertest';
import type { Request } from 'express';
import type { BucketRule } from 'rate-limiter';
import { createApp, normalizePath } from './server';

const perIp: BucketRule<Request> = {
  bucketOf: (req) => req.ip ?? 'unknown',
  rule: { windowMs: 60_000, maxRequests: 3 },
};

const perIpEndpoint: BucketRule<Request> = {
  // Must mirror the server's own bucket derivation so both rules fold correctly.
  bucketOf: (req) => `${req.ip ?? 'unknown'}:${req.method} ${normalizePath(req.path)}`,
  rule: { windowMs: 60_000, maxRequests: 2 },
};

const app = createApp([perIp, perIpEndpoint]);

const get = (ip: string, path = '/api/route') =>
  request(app).get(path).set('X-Forwarded-For', ip);

describe('Given a reference HTTP consumer with per-IP and per-endpoint rules', () => {
  describe('Given a client within its allowance', () => {
    it('when it makes a request, then it is served with the most-restrictive headers', async () => {
      const res = await get('10.0.0.1');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBe('2');
      expect(res.headers['x-ratelimit-remaining']).toBe('1');
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });
  });

  describe('Given a client that exhausts its per-endpoint allowance', () => {
    it('when it keeps hitting the same endpoint, then it is throttled with 429 and Retry-After', async () => {
      await get('10.0.0.2');
      await get('10.0.0.2');
      const res = await get('10.0.0.2');
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBe('0');
      expect(res.body).toMatchObject({
        error: 'Too Many Requests',
        retryAfter: expect.any(Number),
        limit: 2,
        remaining: 0,
        reset: expect.any(Number),
      });
    });
  });

  describe('Given two distinct clients', () => {
    it('when one is throttled, then the other is still served', async () => {
      await get('10.0.0.3');
      await get('10.0.0.3');
      const aliceThrottled = await get('10.0.0.3');
      expect(aliceThrottled.status).toBe(429);

      const bob = await get('10.0.0.4');
      expect(bob.status).toBe(200);
      expect(bob.headers['x-ratelimit-remaining']).toBe('1');
    });
  });
});