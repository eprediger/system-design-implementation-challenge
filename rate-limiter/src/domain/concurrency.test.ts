import { SlidingWindowLimiter } from './sliding-window';
import { MemoryStore } from '../adapter/memory-store';

function makeLimiter() {
  return new SlidingWindowLimiter(new MemoryStore());
}

describe('Given concurrent requests against a sliding window limiter', () => {
  it('when 100 concurrent requests with a limit of 50 are submitted, then exactly 50 are allowed', async () => {
    const limiter = makeLimiter();
    const rule = { key: 'k', windowMs: 60_000, maxRequests: 50 };
    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.check('key', rule)));
    expect(results.filter((r) => r.allowed)).toHaveLength(50);
    expect(results.filter((r) => !r.allowed)).toHaveLength(50);
  });

  it('when 1000 concurrent requests with a limit of 100 are submitted, then exactly 100 are allowed', async () => {
    const limiter = makeLimiter();
    const rule = { key: 'k', windowMs: 60_000, maxRequests: 100 };
    const results = await Promise.all(Array.from({ length: 1000 }, () => limiter.check('key', rule)));
    expect(results.filter((r) => r.allowed)).toHaveLength(100);
  });

  it('when multiple keys are used concurrently, counters stay independent', async () => {
    const limiter = makeLimiter();
    const ruleA = { key: 'a', windowMs: 60_000, maxRequests: 100 };
    const ruleB = { key: 'b', windowMs: 60_000, maxRequests: 1 };
    const all = Array.from({ length: 200 }, (_, i) =>
      i % 2 === 0 ? limiter.check('key-a', ruleA) : limiter.check('key-b', ruleB),
    );
    const results = await Promise.all(all);
    const aResults = results.filter((_, i) => i % 2 === 0);
    const bResults = results.filter((_, i) => i % 2 === 1);
    expect(aResults.filter((r) => r.allowed)).toHaveLength(100);
    expect(bResults.filter((r) => r.allowed)).toHaveLength(1);
  });

  it('10k total requests complete with limits enforced', async () => {
    const limiter = makeLimiter();
    const rule = { key: 'k', windowMs: 60_000, maxRequests: 100 };
    const results = await Promise.all(Array.from({ length: 10_000 }, () => limiter.check('key', rule)));
    expect(results.filter((r) => r.allowed)).toHaveLength(100);
    expect(results).toHaveLength(10_000);
  });
});
