/**
 * Source of time for window math. Injected so tests can drive the wall clock deterministically.
 */
export interface Clock {
  now(): number;
}

/**
 * A throttle rule: how many requests a client may make within a fixed window.
 *
 * The rule carries only policy numbers; scoping (which client, which
 * endpoint) is the caller's job when choosing the `id` passed to
 * {@link SlidingWindowLimiter.check}.
 */
export interface RateLimitRule {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed within `windowMs`. */
  maxRequests: number;
}

/**
 * Outcome of a rate limit check, mirrored into the HTTP response.
 */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** The rule's budget (`maxRequests`). */
  limit: number;
  /** Requests still available in the current window (floored, never negative). */
  remaining: number;
  /** Epoch time in **seconds** at which the current window resets. */
  reset: number;
  /** Seconds to wait before retrying; present only when throttled. */
  retryAfter?: number;
}

/**
 * Sliding-window-counter state for one window: the current window's count and
 * the previous window's count. The limiter blends them by how far into the
 * current window it is.
 */
export interface IncrementResult {
  /** Count in the window `windowIndex`. */
  current: number;
  /** Count in `windowIndex - 1`, decayed by the limiter as the window elapses. */
  previous: number;
}

/**
 * Driven port for counter storage. The domain defines the contract; adapters
 * (in-memory, Redis) implement it.
 */
export interface Store {
  /**
   * Increment the bucket for `windowIndex = floor(now / windowMs)`.
   *
   * Must be atomic per key so concurrent requests never lose a count.
   *
   * @param key - Logical bucket identity (client, endpoint, ...).
   * @param windowMs - Window length in milliseconds.
   * @param windowIndex - Which fixed window is being incremented.
   * @returns The current window's count and the previous window's count.
   */
  increment(key: string, windowMs: number, windowIndex: number): Promise<IncrementResult>;

  /** @returns The count for `windowIndex`, or 0 when absent or expired. */
  get(key: string, windowMs: number, windowIndex: number): Promise<number>;

  /** Clear every bucket under `key` (all window indices). */
  reset(key: string): Promise<void>;

  /** Health probe (used by the circuit breaker); `true` when the store responds. */
  ping(): Promise<boolean>;

  /** Release underlying resources (e.g. connections). */
  close(): Promise<void>;
}

/**
 * Sliding window counter rate limiter.
 *
 * Time is divided into fixed windows of `windowMs`. For a request arriving at
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
export class SlidingWindowLimiter {
  /**
   * @param store - Backing counter store (in-memory or shared/Redis).
   * @param clock - Time source; defaults to `Date.now`.
   */
  constructor(
    private readonly store: Store,
    private readonly clock: Clock = { now: Date.now },
  ) {}

  /**
   * Index of the current fixed window and how many seconds until it resets.
   */
  private windowInfo(now: number, windowMs: number): { index: number; reset: number } {
    const index = Math.floor(now / windowMs);
    const windowEnd = (index + 1) * windowMs;
    return { index, reset: Math.ceil(windowEnd / 1000) };
  }

  /**
   * Decide whether a request for `rule` is allowed, incrementing the counter.
   *
   * @param id - Logical client identity; the counter bucket is scoped to it, so
   *   distinct ids never share a bucket.
   * @param rule - The throttle rule to apply.
   * @returns The decision with the budget mirrored for `X-RateLimit-*` headers.
   * @throws Propagates store failures; callers decide how to fail.
   */
  async check(id: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const now = this.clock.now();
    const { index, reset } = this.windowInfo(now, rule.windowMs);

    const res: IncrementResult = await this.store.increment(id, rule.windowMs, index);

    const elapsed = now - index * rule.windowMs;
    const sectionWeight = elapsed / rule.windowMs; // 0..1, how far into window we are
    const effectiveCount = res.previous * (1 - sectionWeight) + res.current;

    const remaining = Math.max(0, rule.maxRequests - Math.floor(effectiveCount));
    const allowed = effectiveCount <= rule.maxRequests;
    const retryAfter = allowed ? undefined : Math.max(1, Math.ceil((reset * 1000 - now) / 1000));

    return { allowed, limit: rule.maxRequests, remaining, reset, retryAfter };
  }
}