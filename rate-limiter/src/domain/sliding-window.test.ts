import {
  RateLimiterConfigurationError,
  SlidingWindowLimiter,
  type RateLimitRule,
} from './sliding-window';
import type { Store } from './ports';
import { MemoryStore } from '../adapter/memory-store';

const windowMs = 60_000;
const rule = { windowMs, maxRequests: 3 };

describe('Given a sliding window rate limit rule', () => {
  let store: MemoryStore;
  let now: number;

  beforeEach(() => {
    now = 0;
    store = new MemoryStore({ now: () => now });
  });

  function limiterFor<T>(rules: Array<{ bucketOf: (item: T) => string; rule: RateLimitRule }>) {
    return new SlidingWindowLimiter<T>({ store, clock: { now: () => now }, rules });
  }

  const single = (bucketOf: (item: unknown) => string, customRule: RateLimitRule = rule) =>
    limiterFor<unknown>([{ bucketOf, rule: customRule }]);

  describe('Given a client has not exceeded their limit', () => {
    it('when they make a hit, then it is allowed with correct remaining count', async () => {
      const result = await single(() => 'key').check({});
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
      expect(result.limit).toBe(3);
    });

    it('returns all required fields', async () => {
      const result = await single(() => 'key').check({});
      expect(result).toHaveProperty('allowed', true);
      expect(result).toHaveProperty('limit', 3);
      expect(result).toHaveProperty('remaining', 2);
      expect(result).toHaveProperty('reset');
    });
  });

  describe('Given a client has exactly reached their limit', () => {
    it('when they make another hit, then it is throttled', async () => {
      const limiter = single(() => 'key');
      await limiter.check({});
      await limiter.check({});
      await limiter.check({});
      const result = await limiter.check({});
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeDefined();
    });
  });

  describe('Given the time window resets', () => {
    it('when a hit arrives after the reset, then the sliding window allows it', async () => {
      const limiter = single(() => 'key');
      await limiter.check({});
      await limiter.check({});
      await limiter.check({});
      const before = await limiter.check({});
      expect(before.allowed).toBe(false);

      // Note: the denied hit above still counts toward window 0 (window 0
      // now holds 4). Jump 60% into window 1: window 0's weight has decayed to
      // 4 * (1 - 0.6) = 1.6, plus 1 fresh hit = 2.6 <= 3, so it is allowed.
      now = windowMs + 0.6 * windowMs;
      const after = await limiter.check({});
      expect(after.allowed).toBe(true);
    });
  });

  describe('Given the exact limit boundary', () => {
    it('when exactly maxRequests hits arrive, then each is handled correctly', async () => {
      const limiter = single(() => 'key', { ...rule, maxRequests: 1 });
      const first = await limiter.check({});
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(0);
      const second = await limiter.check({});
      expect(second.allowed).toBe(false);
    });
  });

  describe('Given a zero limit', () => {
    it('when any hit arrives, then all are rejected', async () => {
      const result = await single(() => 'key', { ...rule, maxRequests: 0 }).check({});
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });
  });

  describe('Given a single rule', () => {
    it('when it is the first hit, then it is allowed and the next is throttled', async () => {
      const limiter = single(() => 'key', { ...rule, maxRequests: 1 });
      const first = await limiter.check({});
      expect(first.allowed).toBe(true);
      const second = await limiter.check({});
      expect(second.allowed).toBe(false);
    });
  });

  describe('Given hits at a window boundary', () => {
    it('weighs the previous window in full at the boundary (decay, not a hard reset)', async () => {
      const limiter = single(() => 'key');
      await limiter.check({}); // window 0
      await limiter.check({}); // window 0
      now = windowMs; // exactly at the boundary: window 0 still counts at weight 1
      const result = await limiter.check({});
      // 2 * 1.0 + 1 = 3 == maxRequests: a sliding-window counter does not make
      // the whole limit available again the instant a window turns over; it
      // frees up only as the previous window decays.
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('frees capacity only gradually as the previous window decays', async () => {
      const limiter = single(() => 'key');
      await limiter.check({}); // window 0
      await limiter.check({});
      await limiter.check({});
      now = windowMs + 0.5 * windowMs; // half of window 1 elapsed
      const result = await limiter.check({});
      // 3 * 0.5 + 1 = 2.5 <= 3: still allowed, but usage remains high
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });
  });

  describe('Given two distinct identities sharing a rule', () => {
    it('when one exhausts its allowance, then the other is unaffected', async () => {
      const limiter = limiterFor<string>([{ bucketOf: (id) => id, rule }]);
      await limiter.check('alice');
      await limiter.check('alice');
      await limiter.check('alice');
      const bobFirst = await limiter.check('bob');
      expect(bobFirst.allowed).toBe(true);
      expect(bobFirst.remaining).toBe(2);
    });
  });

  describe('Given several rules apply to one hit', () => {
    it('when all are allowed, then the most restrictive one is reported', async () => {
      const limiter = limiterFor<unknown>([
        { bucketOf: () => 'global', rule: { windowMs, maxRequests: 5 } },
        { bucketOf: () => '10.0.0.1:/api', rule: { windowMs, maxRequests: 2 } },
      ]);
      const result = await limiter.check({});
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(2);
      expect(result.remaining).toBe(1);
    });

    it('when one denies, then a denial beats an allowed tie (regression)', async () => {
      const limiter = limiterFor<unknown>([
        { bucketOf: () => 'global', rule: { windowMs, maxRequests: 3 } },
        { bucketOf: () => '10.0.0.1:/api', rule: { windowMs, maxRequests: 2 } },
      ]);
      await limiter.check({});
      await limiter.check({});
      const third = await limiter.check({});
      // global is still within budget (3 <= 3, so it reports remaining 0 but
      // allowed=true); the endpoint budget denies. The denial must win.
      expect(third.allowed).toBe(false);
      expect(third.limit).toBe(2);
      expect(third.remaining).toBe(0);
      expect(third.retryAfter).toBeDefined();
    });

    it('when all deny, then the tightest budget is reported', async () => {
      const limiter = limiterFor<unknown>([
        { bucketOf: () => 'a', rule: { windowMs, maxRequests: 2 } },
        { bucketOf: () => 'b', rule: { windowMs, maxRequests: 5 } },
      ]);
      await limiter.check({});
      await limiter.check({});
      const third = await limiter.check({});
      expect(third.allowed).toBe(false);
      expect(third.limit).toBe(2); // smallest denied budget wins, not the first rule
      expect(third.remaining).toBe(0);
    });

    it('keeps the first rule on two identical denials', async () => {
      const limiter = limiterFor<unknown>([
        { bucketOf: () => 'a', rule: { windowMs, maxRequests: 2 } },
        { bucketOf: () => 'b', rule: { windowMs, maxRequests: 2 } },
      ]);
      await limiter.check({});
      await limiter.check({});
      const third = await limiter.check({});
      expect(third.allowed).toBe(false);
      expect(third.remaining).toBe(0);
    });
  });

  describe('Given the limiter is constructed', () => {
    it('when no rules are configured, then it throws a typed configuration error', () => {
      expect(() => new SlidingWindowLimiter({ store, rules: [] })).toThrow(
        RateLimiterConfigurationError,
      );
    });

    it.each([
      [{ windowMs: 0, maxRequests: 1 }, 'zero windowMs'],
      [{ windowMs: -1, maxRequests: 1 }, 'negative windowMs'],
      [{ windowMs: Number.POSITIVE_INFINITY, maxRequests: 1 }, 'non-finite windowMs'],
      [{ windowMs, maxRequests: -1 }, 'negative maxRequests'],
      [{ windowMs, maxRequests: 1.5 }, 'fractional maxRequests'],
    ])('rejects %s (%s)', (badRule) => {
      expect(
        () => new SlidingWindowLimiter({ store, rules: [{ bucketOf: () => 'key', rule: badRule }] }),
      ).toThrow(RateLimiterConfigurationError);
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
      const failingLimiter = new SlidingWindowLimiter({
        store: failing,
        clock: { now: () => now },
        rules: [{ bucketOf: () => 'key', rule }],
      });
      await expect(failingLimiter.check({})).rejects.toThrow('boom');
    });
  });
});