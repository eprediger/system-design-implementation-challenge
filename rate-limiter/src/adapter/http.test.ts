import express from 'express';
import request from 'supertest';
import { rateLimitMiddleware } from './http';
import { SlidingWindowLimiter, type RateLimitRule, type Store } from '../domain/sliding-window';
import { MemoryStore } from './memory-store';

function buildApp(rule: RateLimitRule, store?: Store, limiter?: SlidingWindowLimiter) {
  const app = express();
  const l = limiter ?? new SlidingWindowLimiter(store ?? new MemoryStore());
  app.use(rateLimitMiddleware({ rules: [rule], limiter: l }));
  app.get('/api', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('Given a rate limiting middleware', () => {
  const rule: RateLimitRule = { key: 'ip', windowMs: 60_000, maxRequests: 2 };

  describe('Given a request that is allowed', () => {
    it('returns 200 and calls next()', async () => {
      const app = buildApp(rule);
      const res = await request(app).get('/api');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('sets the X-RateLimit-* headers', async () => {
      const app = buildApp(rule);
      const res = await request(app).get('/api');
      expect(res.headers['x-ratelimit-limit']).toBe('2');
      expect(res.headers['x-ratelimit-remaining']).toBe('1');
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('does not set Retry-After on allowed requests', async () => {
      const app = buildApp(rule);
      const res = await request(app).get('/api');
      expect(res.headers['retry-after']).toBeUndefined();
    });
  });

  describe('Given a request that is throttled', () => {
    beforeEach(() => {});

    it('returns 429 after exceeding the limit', async () => {
      const app = buildApp(rule);
      await request(app).get('/api');
      await request(app).get('/api');
      const res = await request(app).get('/api');
      expect(res.status).toBe(429);
    });

    it('sets Retry-After and X-RateLimit-* headers on 429', async () => {
      const app = buildApp(rule);
      await request(app).get('/api');
      await request(app).get('/api');
      const res = await request(app).get('/api');
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBe('0');
    });

    it('returns a JSON error body', async () => {
      const app = buildApp(rule);
      await request(app).get('/api');
      await request(app).get('/api');
      const res = await request(app).get('/api');
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({
        error: 'Too Many Requests',
      });
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('retryAfter');
      expect(res.body).toHaveProperty('limit', 2);
      expect(res.body).toHaveProperty('remaining', 0);
    });
  });

  describe('Given only matching rules apply', () => {
    it('skips rules whose pathPattern does not match the route', async () => {
      const app = buildApp({ ...rule, key: 'ip', pathPattern: '/api/auth/*' });
      const res = await request(app).get('/api');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    });
  });

  describe('Given the store fails (fail-open)', () => {
    it('still returns 200 and sets headers from in-memory fallback', async () => {
      const failing: Store = {
        increment: () => Promise.reject(new Error('redis down')),
        get: () => Promise.resolve(0),
        reset: () => Promise.resolve(),
        ping: () => Promise.resolve(true),
        close: () => Promise.resolve(),
      };
      const app = buildApp(rule, failing);
      const res = await request(app).get('/api');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    });
  });
});
