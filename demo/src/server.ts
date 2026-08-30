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

export function createApp(rules: Array<BucketRule<Request>>, storeFactory: () => Store = makeStore) {
  const limiter = new SlidingWindowLimiter({ store: storeFactory(), rules });
  const app = express();
  app.set('trust proxy', true);

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const ruling = await limiter.check(req);
    res.set('X-RateLimit-Limit', String(ruling.limit));
    res.set('X-RateLimit-Remaining', String(ruling.remaining));
    res.set('X-RateLimit-Reset', String(ruling.reset));
    if (ruling.allowed) {
      next();
      return;
    }

    res.set('Retry-After', String(ruling.retryAfter));
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
      bucketOf: (req: Request) => `${req.ip ?? 'unknown'}:${req.path}`,
      rule: { windowMs: 60_000, maxRequests: 10 },
    },
  ]).listen(port, () => console.log(`demo listening on :${port}`));
}