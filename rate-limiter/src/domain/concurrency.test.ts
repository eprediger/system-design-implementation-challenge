import { SlidingWindowLimiter, type RateLimitRule } from './sliding-window';
import { MemoryStore } from '../adapter/memory-store';

function makeLimiter(bucketOf: () => string, rule: RateLimitRule) {
  return new SlidingWindowLimiter({
    store: new MemoryStore(),
    rules: [{ bucketOf, rule }],
  });
}

describe('Given concurrent hits against a sliding window limiter', () => {
  it('when 100 concurrent hits with a limit of 50 are submitted, then exactly 50 are allowed', async () => {
    const limiter = makeLimiter(() => 'k', { windowMs: 60_000, maxRequests: 50 });
    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check({})));
    expect(results.filter((r) => r.allowed)).toHaveLength(50);
    expect(results.filter((r) => !r.allowed)).toHaveLength(50);
  });

  it('when 1000 concurrent hits with a limit of 100 are submitted, then exactly 100 are allowed', async () => {
    const limiter = makeLimiter(() => 'k', { windowMs: 60_000, maxRequests: 100 });
    const results = await Promise.all(Array.from({ length: 1000 }, () => limiter.check({})));
    expect(results.filter((r) => r.allowed)).toHaveLength(100);
  });

  it('when buckets are hit concurrently through shared storage, counters stay independent', async () => {
    const store = new MemoryStore();
    const limiterA = new SlidingWindowLimiter({
      store,
      rules: [{ bucketOf: () => 'key-a', rule: { windowMs: 60_000, maxRequests: 100 } }],
    });
    const limiterB = new SlidingWindowLimiter({
      store,
      rules: [{ bucketOf: () => 'key-b', rule: { windowMs: 60_000, maxRequests: 1 } }],
    });
    const all = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0 ? limiterA.check({}) : limiterB.check({}),
    );
    const results = await Promise.all(all);
    const aResults = results.filter((_, i) => i % 2 === 0);
    const bResults = results.filter((_, i) => i % 2 === 1);
    expect(aResults.filter((r) => r.allowed)).toHaveLength(100);
    expect(bResults.filter((r) => r.allowed)).toHaveLength(1);
  });

  it('10k total hits complete with limits enforced', async () => {
    const limiter = makeLimiter(() => 'k', { windowMs: 60_000, maxRequests: 100 });
    const results = await Promise.all(Array.from({ length: 10_000 }, () => limiter.check({})));
    expect(results.filter((r) => r.allowed)).toHaveLength(100);
    expect(results).toHaveLength(10_000);
  });
});