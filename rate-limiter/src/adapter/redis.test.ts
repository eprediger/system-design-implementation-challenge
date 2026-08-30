import Redis from 'ioredis';
import { RedisStore } from './redis';
import { FailOpenStore } from './fail-open-store';
import { CircuitBreaker } from './circuit-breaker';
import { MemoryStore } from './memory-store';
import { redisAvailable } from '../../jest/redis-available';

const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const windowMs = 60_000;

const describeRedis = redisAvailable ? describe : describe.skip;

describeRedis('Given a Redis-backed store', () => {
  let store: RedisStore;
  let redis: Redis;

  beforeAll(async () => {
    store = new RedisStore(url);
    redis = new Redis(url);
    await store.ping();
    await redis.flushdb();
  });

  afterAll(async () => {
    await store.close();
    redis.disconnect();
  });

  it('returns the current and previous window counts', async () => {
    const id = 'sw-current';
    await expect(store.increment(id, windowMs, 0)).resolves.toEqual({ current: 1, previous: 0 });
    await expect(store.increment(id, windowMs, 0)).resolves.toEqual({ current: 2, previous: 0 });
    await expect(store.increment(id, windowMs, 1)).resolves.toEqual({ current: 1, previous: 2 });
  });

  it('keeps distinct identities isolated', async () => {
    await store.increment('sw-alice', windowMs, 0);
    await store.increment('sw-alice', windowMs, 0);
    await expect(store.increment('sw-bob', windowMs, 0)).resolves.toEqual({ current: 1, previous: 0 });
  });

  it('bounded the counter TTL to two windows (regression)', async () => {
    const id = 'sw-ttl';
    const index = 123_456_789;
    await store.increment(id, windowMs, index);
    const ttlSeconds = await redis.ttl(`rl:${id}:${index}`);
    const expectedSeconds = (2 * windowMs) / 1000;
    expect(ttlSeconds).toBeGreaterThanOrEqual(expectedSeconds - 1);
    expect(ttlSeconds).toBeLessThanOrEqual(expectedSeconds);
  });

  it('reads a stored count and returns 0 for an unknown window', async () => {
    await store.increment('sw-get', windowMs, 42);
    await expect(store.get('sw-get', windowMs, 42)).resolves.toBe(1);
    await expect(store.get('sw-get', windowMs, 43)).resolves.toBe(0);
  });

  it('clears every window of one identity only', async () => {
    await store.increment('sw-reset', windowMs, 0);
    await store.increment('sw-reset', windowMs, 1);
    await store.increment('sw-neighbor', windowMs, 0);
    await store.reset('sw-reset');
    await expect(store.get('sw-reset', windowMs, 0)).resolves.toBe(0);
    await expect(store.get('sw-reset', windowMs, 1)).resolves.toBe(0);
    await expect(store.get('sw-neighbor', windowMs, 0)).resolves.toBe(1);
  });

  it('replies to a health probe', async () => {
    await expect(store.ping()).resolves.toBe(true);
  });

  it('serves through a fail-open store while Redis is reachable', async () => {
    const failOpen = new FailOpenStore({
      primary: new RedisStore(url),
      breaker: new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 30_000, successThreshold: 1 }),
      fallback: new MemoryStore(),
      warn: () => {},
    });

    await expect(failOpen.increment('sw-fo', windowMs, 0)).resolves.toEqual({ current: 1, previous: 0 });
    await expect(failOpen.increment('sw-fo', windowMs, 0)).resolves.toEqual({ current: 2, previous: 0 });
    await failOpen.close();
  });

  it('falls back to in-memory limiting when Redis is unreachable', async () => {
    const warns: string[] = [];
    const liveIndex = Math.floor(Date.now() / windowMs);
    const failOpen = new FailOpenStore({
      primary: new RedisStore('redis://127.0.0.1:6399'),
      breaker: new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 30_000, successThreshold: 1 }),
      fallback: new MemoryStore(),
      warn: (m) => warns.push(m),
    });

    await expect(failOpen.increment('sw-down', windowMs, liveIndex)).resolves.toEqual({ current: 1, previous: 0 });
    await expect(failOpen.increment('sw-down', windowMs, liveIndex)).resolves.toEqual({ current: 2, previous: 0 });
    await expect(failOpen.increment('sw-down', windowMs, liveIndex)).resolves.toEqual({ current: 3, previous: 0 });
    expect(warns).toHaveLength(3);
    await failOpen.close();
  });
});