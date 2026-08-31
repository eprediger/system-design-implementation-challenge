import Redis from 'ioredis';
import net from 'node:net';
import { RedisStore } from './redis';
import { FailOpenStore } from './fail-open-store';
import { MemoryStore } from './memory-store';
import { encodeBucketId } from './bucket-id';
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
    const ttlSeconds = await redis.ttl(`rl:${encodeBucketId(id)}:${index}`);
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
      failureThreshold: 2,
      recoveryTimeoutMs: 30_000,
      successThreshold: 1,
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
      failureThreshold: 2,
      recoveryTimeoutMs: 30_000,
      successThreshold: 1,
      fallback: new MemoryStore(),
      warn: (m) => warns.push(m),
    });

    await expect(failOpen.increment('sw-down', windowMs, liveIndex)).resolves.toEqual({ current: 1, previous: 0 });
    await expect(failOpen.increment('sw-down', windowMs, liveIndex)).resolves.toEqual({ current: 2, previous: 0 });
    await expect(failOpen.increment('sw-down', windowMs, liveIndex)).resolves.toEqual({ current: 3, previous: 0 });
    // Two real primary failures trip the breaker (threshold 2); the third call
    // short-circuits through the now-OPEN circuit and must not warn again.
    expect(warns).toHaveLength(2);
    await failOpen.close();
  });

  it('resets exactly one identity even when ids contain delimiters or glob characters', async () => {
    await store.increment('sw:enc:a', windowMs, 0);
    await store.increment('sw:enc:a:b', windowMs, 0); // prefix twin of the first id
    await store.increment('sw:glob*', windowMs, 0);
    await store.increment('sw:globx', windowMs, 0); // a non-delimiter neighbor
    await store.reset('sw:enc:a');
    await store.reset('sw:glob*');
    await expect(store.get('sw:enc:a', windowMs, 0)).resolves.toBe(0);
    await expect(store.get('sw:glob*', windowMs, 0)).resolves.toBe(0);
    await expect(store.get('sw:enc:a:b', windowMs, 0)).resolves.toBe(1);
    await expect(store.get('sw:globx', windowMs, 0)).resolves.toBe(1);
  });

  it('loses no counts across 100 concurrent increments (atomic Lua)', async () => {
    const id = 'sw-concurrent';
    const results = await Promise.all(
      Array.from({ length: 100 }, () => store.increment(id, windowMs, 0)),
    );
    const currents = results.map((r) => r.current).sort((a, b) => a - b);
    expect(currents).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    await expect(store.get(id, windowMs, 0)).resolves.toBe(100);
  });

  // ponytail: mini TCP relay in front of the real Redis so a store can
  // genuinely lose and regain its connection, without stopping the shared daemon.
  function createRelay() {
    let server: net.Server | null = null;
    let port = 0;
    let closing: Promise<void> = Promise.resolve();
    const sockets = new Set<net.Socket>();
    return {
      address: () => `redis://127.0.0.1:${port}`,
      async listen(): Promise<void> {
        await closing;
        closing = Promise.resolve();
        const srv = net.createServer((down) => {
          sockets.add(down);
          const up = net.connect({ host: new URL(url).hostname, port: Number(new URL(url).port || 6379) });
          down.on('data', (chunk) => up.write(chunk));
          up.on('data', (chunk) => down.write(chunk));
          down.on('error', () => up.destroy());
          up.on('error', () => down.destroy());
          const teardown = () => {
            sockets.delete(down);
            up.destroy();
            down.destroy();
          };
          down.on('close', teardown);
          up.on('close', teardown);
        });
        server = srv;
        await new Promise<void>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen(port, '127.0.0.1', () => {
            if (!port) port = (srv.address() as net.AddressInfo).port;
            resolve();
          });
        });
      },
      kill(): void {
        for (const socket of [...sockets]) socket.destroy();
        if (server) {
          const srv = server;
          server = null;
          closing = new Promise<void>((resolve) => srv.close(() => resolve()));
        }
      },
      async close(): Promise<void> {
        for (const socket of [...sockets]) socket.destroy();
        if (server) {
          const srv = server;
          server = null;
          await new Promise<void>((resolve) => srv.close(() => resolve()));
        }
        await closing;
      },
    };
  }

  it('re-uses its connection once a lost Redis returns (reconnect on demand)', async () => {
    const relay = createRelay();
    await relay.listen();
    const store = new RedisStore(relay.address());

    try {
      await expect(store.increment('sw-recover', windowMs, 0)).resolves.toEqual({ current: 1, previous: 0 });

      relay.kill();
      await expect(store.increment('sw-recover', windowMs, 0)).rejects.toThrow();

      await relay.listen();
      await expect(store.increment('sw-recover', windowMs, 0)).resolves.toEqual({ current: 2, previous: 0 });
    } finally {
      await store.close();
      await relay.close();
    }
  });

  it('reconnects safely when concurrent requests share one client after an outage', async () => {
    const relay = createRelay();
    await relay.listen();
    const store = new RedisStore(relay.address());

    try {
      await store.increment('sw-rc', windowMs, 0); // pre-outage count: 1
      relay.kill();
      await expect(store.increment('sw-rc', windowMs, 0)).rejects.toThrow();
      await relay.listen();

      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.increment('sw-rc', windowMs, 0)),
      );
      const currents = results.map((r) => r.current).sort((a, b) => a - b);
      expect(currents).toEqual(Array.from({ length: 20 }, (_, i) => i + 2)); // 2..21, nothing lost
    } finally {
      await store.close();
      await relay.close();
    }
  });

  it('fails a hung command through commandTimeout instead of hanging forever', async () => {
    // A TCP server that accepts connections but never replies: the store
    // considers itself connected, then the command must time out.
    const sockets = new Set<net.Socket>();
    const blackhole = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    await new Promise<void>((resolve, reject) => {
      blackhole.once('error', reject);
      blackhole.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (blackhole.address() as net.AddressInfo).port;
    const store = new RedisStore(`redis://127.0.0.1:${port}`);

    try {
      await expect(store.increment('sw-blackhole', windowMs, 0)).rejects.toThrow(/timed out/i);
    } finally {
      // The blackholed client never answers QUIT either, so drop the socket
      // directly instead of round-tripping close().
      await store.close().catch(() => {});
      for (const sock of [...sockets]) sock.destroy();
      await new Promise<void>((resolve) => blackhole.close(() => resolve()));
    }
  }, 10_000);
});