import type { RateLimitResult, RateLimitRule } from '../domain/sliding-window';
import { SlidingWindowLimiter } from '../domain/sliding-window';
import { MemoryStore } from './memory-store';

/** Options for {@link rateLimitMiddleware}. */
export interface MiddlewareOptions {
  /** Rules evaluated in order for every request; first denial short-circuits with 429. */
  rules: RateLimitRule[];
  /** Limiter used for the primary store (e.g. Redis-backed); failures fall back to in-memory. */
  limiter: SlidingWindowLimiter;
}

function matchPattern(pattern: string, path: string): boolean {
  if (pattern.endsWith('*')) {
    return path.startsWith(pattern.slice(0, -1));
  }
  return path === pattern;
}

// Extract the identifier the rule counts. Global rules share one bucket;
// per-IP use req.ip; per-endpoint combine ip + path so each client/route is
// independent.
function deriveKey(rule: RateLimitRule, req: { ip?: string; path: string }): string {
  switch (rule.key) {
    case 'global':
      return 'global';
    case 'ip':
      return req.ip ?? 'unknown';
    case 'endpoint':
      return `${req.ip ?? 'unknown'}:${req.path}`;
    default:
      return `${rule.key}:${req.ip ?? 'unknown'}:${req.path}`;
  }
}

/**
 * Connect-style HTTP middleware enforcing `options.rules` per request.
 *
 * Generic by design — any server that calls `(req, res, next)` works; the
 * parameters are duck-typed (`ip`, `path`, `set`/`status`/`json`). Express
 * satisfies it directly.
 *
 * Behavior:
 * - Returns 429 with a JSON body, `Retry-After` and `X-RateLimit-*` headers
 *   when the first applicable rule denies. `X-RateLimit-*` are also set on
 *   allowed responses.
 * - **Fail-open:** if `limiter.check` throws (e.g. Redis down), the request is
 *   served anyway, counted against a throwaway in-memory limiter, and the
 *   issue is logged at warn.
 *
 * @param opts - Rules and primary limiter.
 * @returns An async `(req, res, next)` middleware handler.
 */
export function rateLimitMiddleware(opts: MiddlewareOptions) {
  const fallback = new SlidingWindowLimiter(new MemoryStore());
  return async (req: { ip?: string; path: string }, res: any, next: () => void) => {
    for (const rule of opts.rules) {
      if (rule.pathPattern && !matchPattern(rule.pathPattern, req.path)) {
        continue;
      }
      const id = deriveKey(rule, req);
      let result: RateLimitResult;
      try {
        result = await opts.limiter.check(id, rule);
      } catch (err) {
        // Fail-open: Redis is down; serve from in-memory fallback. Log WARN.
        console.warn(`[rate-limiter] fallback to in-memory for ${id}: ${(err as Error).message}`);
        result = await fallback.check(id, rule);
      }
      applyHeaders(res, result);
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfter));
        res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
          retryAfter: result.retryAfter,
          limit: result.limit,
          remaining: result.remaining,
          reset: result.reset,
        });
        return;
      }
    }
    next();
  };
}

function applyHeaders(
  res: any,
  result: RateLimitResult,
): void {
  res.set('X-RateLimit-Limit', String(result.limit));
  res.set('X-RateLimit-Remaining', String(result.remaining));
  res.set('X-RateLimit-Reset', String(result.reset));
}