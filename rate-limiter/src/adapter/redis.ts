import Redis from 'ioredis';
import type { IncrementResult, Store } from '../domain/ports';
import { encodeBucketId } from './bucket-id';

const KEY_PREFIX = 'rl';

const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
local previous = redis.call('GET', KEYS[2])
if not previous then previous = 0 end
return { current, tonumber(previous) }
`;

// ponytail: the two-key EVAL assumes a single-node/HA Redis — on a Cluster
// topology the keys sit in different slots and the script fails with
// CROSSSLOT. Add hash tags (`{tag}`) on the keys if cluster support is ever
// needed.

// Reset runs inside one EVAL so a concurrent increment can never interleave
// with the deletion scan (Redis executes a script atomically).
const RESET_SCRIPT = `
local cursor = '0'
repeat
  local result = redis.call('SCAN', cursor, 'MATCH', ARGV[1], 'COUNT', 100)
  cursor = result[1]
  for _, key in ipairs(result[2]) do
    redis.call('DEL', key)
  end
until cursor == '0'
return 0
`;

function counterKey(id: string, windowIndex: number): string {
  return `${KEY_PREFIX}:${encodeBucketId(id)}:${windowIndex}`;
}

function resetPattern(id: string): string {
  return `${KEY_PREFIX}:${encodeBucketId(id)}:*`;
}

/**
 * Redis-backed {@link Store}. One atomic Lua script increments the current
 * window and reads the previous one, so concurrent requests never lose a count
 * across processes sharing the same Redis.
 *
 * Keys live for `2 * windowMs` (the current window's remaining life plus the
 * previous window), then expire on their own.
 *
 * `commandTimeout` fails a command that gets no reply within 2s (e.g. a
 * half-open connection silently dropping packets), so even a connection that
 * never closes surfaces to the fail-open wrapper instead of hanging it.
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
      commandTimeout: 2000,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });
    this.redis.on('error', () => {});
  }

  // The bounded retryStrategy ends the client while Redis stays down; reconnect
  // on demand so the fail-open wrapper can serve from Redis again once it
  // recovers instead of rejecting forever. Memoize the in-flight connect so
  // concurrent requests sharing one client never connect twice.
  private connecting: Promise<void> | null = null;

  private async run<T>(op: (client: Redis) => Promise<T>): Promise<T> {
    if (this.redis.status === 'end') {
      this.connecting ??= this.redis.connect().finally(() => {
        this.connecting = null;
      });
      await this.connecting;
    }
    return op(this.redis);
  }

  async increment(key: string, windowMs: number, windowIndex: number): Promise<IncrementResult> {
    const ttlMs = 2 * windowMs;
    const result = (await this.run((client) =>
      client.eval(INCREMENT_SCRIPT, 2, counterKey(key, windowIndex), counterKey(key, windowIndex - 1), ttlMs),
    )) as [number, number];
    return { current: result[0], previous: result[1] };
  }

  async get(key: string, windowMs: number, windowIndex: number): Promise<number> {
    const raw = await this.run((client) => client.get(counterKey(key, windowIndex)));
    return raw === null ? 0 : Number(raw);
  }

  async reset(key: string): Promise<void> {
    await this.run((client) => client.eval(RESET_SCRIPT, 0, resetPattern(key)));
  }

  async ping(): Promise<boolean> {
    const pong = await this.run((client) => client.ping());
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