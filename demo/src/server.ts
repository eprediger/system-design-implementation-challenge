import express, { type NextFunction, type Request, type Response } from 'express';
import {
  CircuitBreaker,
  FailOpenStore,
  MemoryStore,
  RedisStore,
  SlidingWindowLimiter,
  type BucketRule,
  type Emitter,
  type Store,
} from 'rate-limiter';
import type { AppLogger } from './logger';
import { createLogger } from './logger';
import { createMetrics, timedStore, type DemoMetrics } from './metrics';
import { createEmitter, newWideEvent, requestCtx, type WideEvent } from './wide-event';

function makeStore(events?: Emitter): Store {
  const url = process.env.REDIS_URL;
  if (!url) return new MemoryStore();
  return new FailOpenStore({
    primary: new RedisStore(url),
    breaker: new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 30_000, successThreshold: 1, events }),
    fallback: new MemoryStore(),
    events,
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

/**
 * Build the demo Express app. `storeFactory(events)` lets callers substitute a
 * store while still receiving the observability event sink; an injected
 * `logger` replaces the default pino instance.
 */
export function createApp(
  rules: Array<BucketRule<Request>>,
  storeFactory: (events?: Emitter) => Store = makeStore,
  logger?: AppLogger,
) {
  const appLogger = logger ?? createLogger();
  if (!logger && process.env.NODE_ENV === 'test') appLogger.level = 'silent';
  const app = express();
  // Only trust the proxy's X-Forwarded-For when the request is loopback, a
  // remote client cannot spoof per-IP limits. Consumers behind a real proxy
  // set TRUST_PROXY=true.
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : 'loopback');
  app.disable('x-powered-by');

  const metrics: DemoMetrics = createMetrics();
  const emitter = createEmitter(metrics, appLogger, rules);
  const store = timedStore(storeFactory(emitter), metrics.storeOpMs);
  const limiter = new SlidingWindowLimiter({ store, rules, events: emitter });

  app.get('/metrics', async (_req: Request, res: Response) => {
    res.type('text/plain').send(await metrics.registry.metrics());
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const wide: WideEvent = newWideEvent(req);
    res.locals.wide = wide;
    const started = performance.now();
    res.on('finish', () => {
      const code = res.statusCode;
      const line: WideEvent = { ...wide, status_code: code, duration_ms: Math.round(performance.now() - started) };
      if (code >= 500) appLogger.error(line, 'request errored');
      else if (code === 429) appLogger.warn(line, 'request throttled');
      else appLogger.info(line, 'request handled');
    });
    return requestCtx.run({ wide }, () => handle(limiter, metrics, req, res, next, started));
  });

  app.get('/api/route', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const wide = res.locals.wide as WideEvent | undefined;
    if (wide) wide.error = { type: err.name ?? 'Error', message: err.message, stack: err.stack };
    metrics.errorsTotal.inc({ type: err.name ?? 'Error' });
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

async function handle(
  limiter: SlidingWindowLimiter<Request>,
  metrics: DemoMetrics,
  req: Request,
  res: Response,
  next: NextFunction,
  started: number,
): Promise<void> {
  const ruling = await limiter.check(req);
  metrics.checkMs.observe(performance.now() - started);
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