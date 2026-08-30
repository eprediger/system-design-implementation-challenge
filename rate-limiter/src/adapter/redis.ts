import Redis from 'ioredis';
import type { IncrementResult, Store } from '../domain/ports';

const KEY_PREFIX = 'rl';

const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
local previous = redis.call('GET', KEYS[2])
if not previous then previous = 0 end
return { current, tonumber(previous) }
`;

function counterKey(id: string, windowIndex: number): string {
  return `${KEY_PREFIX}:${id}:${windowIndex}`;
}

/**
 * Redis-backed {@link Store}. One atomic Lua script increments the current
 * window and reads the previous one, so concurrent requests never lose a count
 * across processes sharing the same Redis.
 *
 * Keys live for `2 * windowMs` (the current window's remaining life plus the
 * previous window), then expire on their own.
 */
export class RedisStore implements Store {
  private readonly redis: Redis;

  /**
   * @param url - Full Redis connection URL, e.g. `redis://127.0.0.1:6379`.
   */
  constructor(url: string) {
    // Fail fast when Redis is down so the fail-open wrapper can serve instead
    // of hanging a request behind ioredis's reconnect queue. `retryStrategy`
    // returning null after a few attempts ends the client and rejects queued
    // commands, so a dead Redis surfaces in ~1s.
    this.redis = new Redis(url, {
      connectTimeout: 2000,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });
    this.redis.on('error', () => {});
  }

  async increment(key: string, windowMs: number, windowIndex: number): Promise<IncrementResult> {
    const ttlMs = 2 * windowMs;
    const result = (await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      counterKey(key, windowIndex),
      counterKey(key, windowIndex - 1),
      ttlMs,
    )) as [number, number];
    return { current: result[0], previous: result[1] };
  }

  async get(key: string, windowMs: number, windowIndex: number): Promise<number> {
    const raw = await this.redis.get(counterKey(key, windowIndex));
    return raw === null ? 0 : Number(raw);
  }

  async reset(key: string): Promise<void> {
    const stream = this.redis.scanStream({ match: `${KEY_PREFIX}:${key}:*`, count: 100 });
    const pipeline = this.redis.pipeline();
    for await (const batch of stream) {
      if (batch.length > 0) {
        pipeline.del(...batch);
      }
    }
    await pipeline.exec();
  }

  async ping(): Promise<boolean> {
    const pong = await this.redis.ping();
    return pong === 'PONG';
  }

  async close(): Promise<void> {
    if (this.redis.status === 'end') return;
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      // Fails-fast clients may never have connected; quit() needs a live
      // connection, so drop it locally instead of round-tripping QUIT.
      this.redis.disconnect();
    }
  }
}