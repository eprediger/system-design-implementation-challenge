import net from 'node:net';

const DEFAULT_URL = 'redis://127.0.0.1:6379';

// ponytail: net probe instead of the lib's ioredis ping — demo has no ioredis
// dep and a TCP connect is all the gate needs.
function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port || 6379) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export default async function globalSetup(): Promise<void> {
  const reachable = await probe(process.env.REDIS_URL ?? DEFAULT_URL);
  (global as Record<string, unknown>).__REDIS_AVAILABLE__ = reachable;
}