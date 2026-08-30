import { RateLimitResult } from './rate-limit-result';
import type { Clock, IncrementResult, Store } from './ports';

/**
 * A throttle rule: how many hits a client may make within a fixed window.
 *
 * The rule carries only policy numbers. Which bucket a hit belongs to is the
 * consumer's job, expressed as the {@link BucketRule.bucketOf} function that
 * rides alongside each rule — never as a string that can misspell a bucket.
 */
export interface RateLimitRule {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum hits allowed within `windowMs`. */
  maxRequests: number;
}

/**
 * Signals a limiter configuration that violates an invariant: a limiter must
 * be built with at least one rule, and every rule must have a positive finite
 * `windowMs` and an integer, non-negative `maxRequests`. Root cause at
 * construction time, so a silent no-op or nonsense limiter can never be
 * mistaken for a working one.
 */
export class RateLimiterConfigurationError extends Error {
  constructor(message?: string) {
    super(message ?? 'SlidingWindowLimiter requires at least one rule');
    this.name = 'RateLimiterConfigurationError';
  }
}

/**
 * A rule bound to the bucket it governs.
 *
 * The library declares the signature; the consumer implements
 * {@link BucketRule.bucketOf} on every rule, so a rule and its bucket
 * derivation can never fall out of sync.
 *
 * `T` is the unit of work being checked (an HTTP request, a queued job, any
 * event); `bucketOf` maps it to its counter bucket.
 */
export interface BucketRule<T> {
  /** Maps the checked item to the counter bucket it belongs to. */
  bucketOf(item: T): string;
  rule: RateLimitRule;
}

export interface SlidingWindowLimiterOptions<T> {
  /** Backing counter store (in-memory or shared/Redis). */
  store: Store;
  /** Rules enforced on every checked item; must be non-empty. */
  rules: Array<BucketRule<T>>;
  /** Time source; defaults to `Date.now`. */
  clock?: Clock;
}

/**
 * Sliding window counter rate limiter.
 *
 * Time is divided into fixed windows of `windowMs`. For a hit arriving at
 * time T in window index `cur`, the effective usage is the previous window's
 * count weighted by how much of the window has not yet elapsed, plus the
 * current window's count:
 *
 * ```
 * weight         = 1 - elapsedInWindow / windowMs
 * effectiveCount = previous * weight + current
 * ```
 *
 * O(1) time and O(1) memory per key (two counters), unlike a sliding window
 * *log* which is O(n).
 */
export class SlidingWindowLimiter<T> {
  private readonly store: Store;
  private readonly rules: Array<BucketRule<T>>;
  private readonly clock: Clock;

  /**
   * @throws {RateLimiterConfigurationError} - when no rules are configured.
   */
  constructor(options: SlidingWindowLimiterOptions<T>) {
    if (options.rules.length === 0) {
      throw new RateLimiterConfigurationError();
    }
    for (const { rule } of options.rules) {
      if (!Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
        throw new RateLimiterConfigurationError('rule.windowMs must be a finite positive number');
      }
      if (!Number.isInteger(rule.maxRequests) || rule.maxRequests < 0) {
        throw new RateLimiterConfigurationError('rule.maxRequests must be a non-negative integer');
      }
    }
    this.store = options.store;
    this.rules = options.rules;
    this.clock = options.clock ?? { now: Date.now };
  }

  /**
   * Index of the current fixed window and how many seconds until it resets.
   */
  private windowInfo(now: number, windowMs: number): { index: number; reset: number } {
    const index = Math.floor(now / windowMs);
    const windowEnd = (index + 1) * windowMs;
    return { index, reset: Math.ceil(windowEnd / 1000) };
  }

  /**
   * Ruling for `item` across every configured rule.
   *
   * Each rule counts the hit against its own bucket (via
   * {@link BucketRule.bucketOf}); the verdicts are folded by
   * {@link RateLimitResult.isMoreRestrictiveThan} into one ruling — the first
   * rule seeds it, a denying verdict beats an allowed tie, otherwise the
   * lowest `remaining` wins, and the first rule keeps the ruling on an exact
   * tie. The single `RateLimitResult` mirrors the ruling rule's budget for
   * `X-RateLimit-*` headers.
   *
   * @throws Propagates store failures; callers decide how to fail.
   */
  async check(item: T): Promise<RateLimitResult> {
    const [first, ...rest] = this.rules;
    let ruling = await this.checkBucket(first.bucketOf(item), first.rule);
    for (const { bucketOf, rule } of rest) {
      const result = await this.checkBucket(bucketOf(item), rule);
      if (result.isMoreRestrictiveThan(ruling)) {
        ruling = result;
      }
    }
    return ruling;
  }

  private async checkBucket(bucket: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const now = this.clock.now();
    const { index, reset } = this.windowInfo(now, rule.windowMs);

    const res: IncrementResult = await this.store.increment(bucket, rule.windowMs, index);

    const elapsed = now - index * rule.windowMs;
    const sectionWeight = elapsed / rule.windowMs; // 0..1, how far into window we are
    const effectiveCount = res.previous * (1 - sectionWeight) + res.current;

    // Ceil the effective usage so a fraction of decayed usage is never reported
    // as a full free hit — `remaining` must never overstate availability.
    const remaining = Math.max(0, rule.maxRequests - Math.ceil(effectiveCount));
    const allowed = effectiveCount <= rule.maxRequests;
    const retryAfter = allowed ? undefined : Math.max(1, Math.ceil((reset * 1000 - now) / 1000));

    return new RateLimitResult(allowed, rule.maxRequests, remaining, reset, retryAfter);
  }
}
