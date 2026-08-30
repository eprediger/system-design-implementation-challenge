import express, { type NextFunction, type Request, type Response } from 'express';
import {
  CircuitBreaker,
  FailOpenStore,
  MemoryStore,
  RedisStore,
  SlidingWindowLimiter,
  type BucketRule,
  type Store,
} from 'rate-limiter';

function makeStore(): Store {
  const url = process.env.REDIS_URL;
  if (!url) return new MemoryStore();
  return new FailOpenStore({
    primary: new RedisStore(url),
    breaker: new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 30_000, successThreshold: 1 }),
    fallback: new MemoryStore(),
  });
}

/**
 * Canonicalize a request path so spelling variants of the same endpoint share
 * one counter bucket: percent-decoded, duplicate slashes collapsed.
 */
export function normalizePath(path: string): string {
  try {
    return decodeURIComponent(path).replace(/\/+/g, '/');
  } catch {
    return path; // malformed percent-encoding: keep the raw path as its own bucket
  }
}

function perIpEndpointBucket(req: Request): string {
  return `${req.ip ?? 'unknown'}:${req.method} ${normalizePath(req.path)}`;
}

export function createApp(rules: Array<BucketRule<Request>>, storeFactory: () => Store = makeStore) {
  const limiter = new SlidingWindowLimiter({ store: storeFactory(), rules });
  const app = express();
  // Only trust the proxy's X-Forwarded-For when the request is loopback, a
  // remote client cannot spoof per-IP limits. Consumers behind a real proxy
  // set TRUST_PROXY=true.
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : 'loopback');
  app.disable('x-powered-by');

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const ruling = await limiter.check(req);
    res.set('X-RateLimit-Limit', String(ruling.limit));
    res.set('X-RateLimit-Remaining', String(ruling.remaining));
    res.set('X-RateLimit-Reset', String(ruling.reset));
    if (ruling.allowed) {
      next();
      return;
    }

    if (ruling.retryAfter !== undefined) {
      res.set('Retry-After', String(ruling.retryAfter));
    }
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${ruling.retryAfter} seconds.`,
      retryAfter: ruling.retryAfter,
      limit: ruling.limit,
      remaining: ruling.remaining,
      reset: ruling.reset,
    });
  });

  app.get('/api/route', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  createApp([
    { bucketOf: () => 'global', rule: { windowMs: 60_000, maxRequests: 1000 } },
    { bucketOf: (req: Request) => req.ip ?? 'unknown', rule: { windowMs: 60_000, maxRequests: 100 } },
    {
      bucketOf: perIpEndpointBucket,
      rule: { windowMs: 60_000, maxRequests: 10 },
    },
  ]).listen(port, () => console.log(`demo listening on :${port}`));
}