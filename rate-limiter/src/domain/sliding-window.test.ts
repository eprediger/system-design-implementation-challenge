import { SlidingWindowLimiter, type Store } from './sliding-window';
import { MemoryStore } from '../adapter/memory-store';

const windowMs = 60_000;
const rule = { key: 'test', windowMs, maxRequests: 3 };

describe('Given a sliding window rate limit rule', () => {
  let store: MemoryStore;
  let limiter: SlidingWindowLimiter;
  let now: number;

  beforeEach(() => {
    now = 0;
    store = new MemoryStore({ now: () => now });
    limiter = new SlidingWindowLimiter(store, { now: () => now });
  });

  describe('Given a client has not exceeded their limit', () => {
    it('when they make a request, then it is allowed with correct remaining count', async () => {
      const result = await limiter.check('key', rule);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
      expect(result.limit).toBe(3);
    });

    it('returns all required fields', async () => {
      const result = await limiter.check('key', rule);
      expect(result).toHaveProperty('allowed', true);
      expect(result).toHaveProperty('limit', 3);
      expect(result).toHaveProperty('remaining', 2);
      expect(result).toHaveProperty('reset');
    });
  });

  describe('Given a client has exactly reached their limit', () => {
    beforeEach(async () => {
      await limiter.check('key', rule);
      await limiter.check('key', rule);
      await limiter.check('key', rule);
    });

    it('when they make another request, then it is throttled', async () => {
      const result = await limiter.check('key', rule);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeDefined();
    });
  });

  describe('Given the time window resets', () => {
    it('when a request arrives after the reset, then the sliding window allows it', async () => {
      await limiter.check('key', rule);
      await limiter.check('key', rule);
      await limiter.check('key', rule);
      const before = await limiter.check('key', rule);
      expect(before.allowed).toBe(false);

      // Note: the denied request above still count toward window 0 (window 0
      // now holds 4). Jump 60% into window 1: window 0's weight has decayed to
      // 4 * (1 - 0.6) = 1.6, plus 1 fresh request = 2.6 <= 3, so it is allowed.
      now = windowMs + 0.6 * windowMs;
      const after = await limiter.check('key', rule);
      expect(after.allowed).toBe(true);
    });
  });

  describe('Given the exact limit boundary', () => {
    it('when exactly maxRequests requests arrive, then each is handled correctly', async () => {
      const first = await limiter.check('key', { ...rule, maxRequests: 1 });
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(0);
      const second = await limiter.check('key', { ...rule, maxRequests: 1 });
      expect(second.allowed).toBe(false);
    });
  });

  describe('Given a zero limit', () => {
    it('when any request arrives, then all are rejected', async () => {
      const result = await limiter.check('key', { ...rule, maxRequests: 0 });
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  describe('Given a single request', () => {
    it('when it is the first, then it is allowed and the next is throttled', async () => {
      const first = await limiter.check('key', { ...rule, maxRequests: 1 });
      expect(first.allowed).toBe(true);
      const second = await limiter.check('key', { ...rule, maxRequests: 1 });
      expect(second.allowed).toBe(false);
    });
  });

  describe('Given requests spanning a window boundary', () => {
    it('weights previous window usage by how much time has elapsed', async () => {
      await limiter.check('key', rule); // window 0
      now = windowMs + 1; // move into window 1 almost entirely
      limiter.check('key', rule);
      now = windowMs + 1;
      const result = await limiter.check('key', rule);
      // only 1 request in the far-right of window 1, previous window is fully expired
      expect(result.allowed).toBe(true);
    });
  });

  describe('When the store fails', () => {
    it('propagates the error', async () => {
      const failing: Store = {
        increment: () => Promise.reject(new Error('boom')),
        get: () => Promise.resolve(0),
        reset: () => Promise.resolve(),
        ping: () => Promise.resolve(true),
        close: () => Promise.resolve(),
      };
      const failingLimiter = new SlidingWindowLimiter(failing, { now: () => now });
      await expect(failingLimiter.check('key', rule)).rejects.toThrow('boom');
    });
  });
});
