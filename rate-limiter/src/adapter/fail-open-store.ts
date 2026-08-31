import type { Emitter } from '../domain/events';
import type { IncrementResult, Store } from '../domain/ports';

/** Options for {@link FailOpenStore}. */
export interface FailOpenStoreOptions {
  /** Preferred store (e.g. shared Redis). */
  primary: Store;
  /** In-process store that serves while the primary is unavailable. */
  fallback: Store;
  /** Consecutive primary failures that trip the circuit to OPEN. Must be >= 1. */
  failureThreshold: number;
  /** How long `OPEN` holds before the next call probes recovery, in milliseconds. */
  recoveryTimeoutMs: number;
  /** Successful probes in `HALF_OPEN` that close the circuit. Must be >= 1. */
  successThreshold: number;
  /** Time source; injectable for deterministic tests. */
  now?: () => number;
  /** Sink for the WARN line emitted on a real primary failure; defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Observability sink; receives a `storeFallback` event per fallback serve (optional). */
  events?: Emitter;
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * A {@link Store} that serves (fail-open) instead of blocking when the primary
 * store is unavailable: every operation runs through the circuit logic, and
 * any failure — a tripped circuit or a throwing primary — falls back to the
 * in-memory store. A real primary failure is logged at WARN; callers
 * short-circuited while the breaker is OPEN. When the primary recovers, the
 * half-open probe closes the circuit and Redis is re-used.
 */
export class FailOpenStore implements Store {
  private primary: Store;
  private fallback: Store;
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly warn: (message: string) => void;
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private failuresBefore = 0;

  // ... in the constructor, initialize: this.failuresBefore = 0;
  private successes = 0;
  private openedAt = 0;
  private probing = false;
  private readonly now: () => number;
  private readonly events?: Emitter;

  constructor(opts: FailOpenStoreOptions) {
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.failureThreshold = opts.failureThreshold;
    this.recoveryTimeoutMs = opts.recoveryTimeoutMs;
    this.successThreshold = opts.successThreshold;
    this.warn = opts.warn ?? ((message) => console.warn(message));
    this.now = opts.now ?? Date.now;
    this.events = opts.events;
    this.failuresBefore = 0;
  }

  private transitionToOpen(failureCount: number, lastError?: Error): void {
    this.state = 'OPEN';
    this.openedAt = this.now();
    this.failures = 0;
    this.successes = 0;
    this.probing = false;
    // Removed breakerOpened emission - FailOpenStore uses storeFallback events instead
  }

  private transitionToClosed(successCount: number): void {
    this.state = 'CLOSED';
    this.events?.emit({ type: 'breakerClosed', successCount });
    this.successes = 0;
  }

private async guard<T>(
    key: string,
    run: (s: Store) => Promise<T>,
    fallbackRun: (s: Store) => Promise<T>,
  ): Promise<T> {
    // Determine fallback reason before state checks
    const wasCircuitOpen = this.failures >= this.failureThreshold;
    const fallbackReason = wasCircuitOpen ? 'open' : 'error';

    // ONE in-flight probe only: with `probing` set, every concurrent call
    // short-circuits to the fallback instead of piling onto the dependency.
    if (this.state === 'HALF_OPEN') {
      if (this.probing) {
        this.events?.emit({ type: 'storeFallback', key, fallbackType: 'memory', reason: fallbackReason, lastError: undefined });
        return fallbackRun(this.fallback);
      }
      this.probing = true;
    }

    // Circuit OPEN and still cooling down: short-circuit to fallback
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt >= this.recoveryTimeoutMs) {
        this.state = 'HALF_OPEN';
      } else {
        // Circuit already open - emit fallback event and short-circuit
        this.events?.emit({ type: 'storeFallback', key, fallbackType: 'memory', reason: 'open', lastError: undefined });
        return fallbackRun(this.fallback);
      }
    }

    try {
      const result = await run(this.primary);
      // Success path
      if (this.state === 'HALF_OPEN') {
        this.successes++;
        if (this.successes >= this.successThreshold) {
          this.transitionToClosed(this.successes);
        }
        this.probing = false;
        return result;
      } else {
        this.failures = 0;
        this.probing = false;
        return result;
      }
    } catch (err) {
      const lastError = err instanceof Error ? err : new Error(String(err));

      // Failure path
      if (this.state === 'HALF_OPEN') {
        this.transitionToOpen(1, lastError);
      } else if (this.state === 'CLOSED') {
        this.failures++;
        if (this.failures >= this.failureThreshold) {
          this.transitionToOpen(this.failures, lastError);
        }
      }

      this.events?.emit({ type: 'storeFallback', key, fallbackType: 'memory', reason: fallbackReason, lastError });
      this.warn('rate-limiter fail-open: primary store unavailable, serving from memory');
      return fallbackRun(this.fallback);
    }
  }

  /** See {@link Store.increment}. */
  increment(key: string, windowMs: number, windowIndex: number): Promise<IncrementResult> {
    return this.guard(
      key,
      (s) => s.increment(key, windowMs, windowIndex),
      (s) => s.increment(key, windowMs, windowIndex),
    );
  }

  /** See {@link Store.get}. */
  get(key: string, windowMs: number, windowIndex: number): Promise<number> {
    return this.guard(
      key,
      (s) => s.get(key, windowMs, windowIndex),
      (s) => s.get(key, windowMs, windowIndex),
    );
  }

  /** See {@link Store.reset}. */
  reset(key: string): Promise<void> {
    return this.guard(
      key,
      (s) => s.reset(key),
      (s) => s.reset(key),
    );
  }

  /** See {@link Store.ping}. Falls back to the fallback store's answer. */
  ping(): Promise<boolean> {
    return this.guard(
      'ping',
      (s) => s.ping(),
      (s) => s.ping(),
    );
  }

  /** Release both stores' resources. */
  async close(): Promise<void> {
    await Promise.all([this.primary.close(), this.fallback.close()]);
  }
}