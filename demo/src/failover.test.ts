import net from 'node:net';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { FailOpenStore, MemoryStore, RedisStore, type BucketRule, type Store } from 'rate-limiter';
import { createApp } from './server';
import { redisAvailable } from '../jest/redis-available';

const describeRedis = redisAvailable ? describe : describe.skip;

const perIp: BucketRule<Request> = {
  bucketOf: (req) => req.ip ?? 'unknown',
  rule: { windowMs: 60_000, maxRequests: 1000 },
};

// Transparent TCP relay in front of the real Redis, so the outage is a socket
// flap the store genuinely experiences — the shared Redis itself never stops.
function createRelay(targetHost: string, targetPort: number) {
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
        const up = net.connect({ host: targetHost, port: targetPort });
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

type Relay = ReturnType<typeof createRelay>;

describeRedis('Given two server instances whose Redis is fronted by a fault-injection relay', () => {
  const token = `failover-${randomUUID()}.invalid`;
  const warns: string[] = [];
  let relay: Relay;
  let apps: ReturnType<typeof createApp>[];
  const failOpens: Store[] = [];

  beforeAll(async () => {
    const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    relay = createRelay(url.hostname, Number(url.port || 6379));
    await relay.listen();

    const storeFactory = (): Store => {
      const store = new FailOpenStore({
        primary: new RedisStore(relay.address()),
        fallback: new MemoryStore(),
        failureThreshold: 1,
        recoveryTimeoutMs: 500,
        successThreshold: 1,
        warn: (message) => warns.push(message),
      });
      failOpens.push(store);
      return store;
    };
    apps = [createApp([perIp], storeFactory), createApp([perIp], storeFactory)];
  });

  afterAll(async () => {
    await Promise.all(failOpens.map((store) => store.close()));
    await relay.close();
  });

  it('serves through the relay to the shared Redis while it is up', async () => {
    const res = await request(apps[0])
      .get('/api/route')
      .set('X-Forwarded-For', token)
      .timeout({ response: 5000, deadline: 5000 });
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('1000');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('keeps serving from the in-memory fallback while Redis is unreachable', async () => {
    relay.kill();
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        request(apps[i % 2]).get('/api/route').set('X-Forwarded-For', token).timeout({ response: 5000, deadline: 5000 }),
      ),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    // Fail-open still mirrors the ruling into the rate-limit headers (US-6).
    expect(
      responses.every(
        (r) =>
          r.headers['x-ratelimit-limit'] === '1000' &&
          r.headers['x-ratelimit-remaining'] !== undefined &&
          r.headers['x-ratelimit-reset'] !== undefined,
      ),
    ).toBe(true);
  }, 10_000);

  it('re-seats on the shared Redis once the outage is over', async () => {
    await relay.listen();
    await new Promise((resolve) => setTimeout(resolve, 600)); // past recoveryTimeoutMs

    const res = await request(apps[0])
      .get('/api/route')
      .set('X-Forwarded-For', token)
      .timeout({ response: 5000, deadline: 5000 });
    expect(res.status).toBe(200);

    const warnsBefore = warns.length;
    await request(apps[1])
      .get('/api/route')
      .set('X-Forwarded-For', token)
      .timeout({ response: 5000, deadline: 5000 });
    expect(warns).toHaveLength(warnsBefore);
  }, 10_000);
});