import Redis from 'ioredis';

const DEFAULT_URL = 'redis://127.0.0.1:6379';

export default async function globalSetup(): Promise<void> {
  const client = new Redis(process.env.REDIS_URL ?? DEFAULT_URL, {
    lazyConnect: true,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  client.on('error', () => {});
  let reachable = false;
  try {
    await client.connect();
    await client.ping();
    reachable = true;
  } catch {
    reachable = false;
  } finally {
    client.disconnect();
  }
  (global as Record<string, unknown>).__REDIS_AVAILABLE__ = reachable;
}