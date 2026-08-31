import type { Emitter } from '../domain/events';
import type { IncrementResult, Store } from '../domain/ports';
import { CircuitOpenError } from './circuit-breaker';
import type { CircuitBreaker } from './circuit-breaker';

/** Options for {@link FailOpenStore}. */
export interface FailOpenStoreOptions {
  /** Preferred store (e.g. shared Redis). */
  primary: Store;
  /** Guards the primary; when OPEN the primary is skipped entirely. */
  breaker: CircuitBreaker;
  /** In-process store that serves while the primary is unavailable. */
  fallback: Store;
  /** Sink for the WARN line emitted on a real primary failure; defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Observability sink; receives a `storeFallback` event per fallback serve (optional). */
  events?: Emitter;
}

/**
 * A {@link Store} that serves (fail-open) instead of blocking when the primary
 * store is unavailable: every operation runs through the circuit breaker, and
 * any failure — a tripped circuit or a throwing primary — falls back to the
 * in-memory store. A real primary failure is logged at WARN; callers
 * short-circuited while the breaker is OPEN (a `CircuitOpenError`) fall back
 * silently, one line was enough when the trip happened. When the primary
 * recovers, the breaker's half-open probe closes the circuit and Redis is
 * re-used.
 */
export class FailOpenStore implements Store {
  private readonly primary: Store;
  private readonly breaker: CircuitBreaker;
  private readonly fallback: Store;
  private readonly warn: (message: string) => void;
  private readonly events?: Emitter;

  constructor(opts: FailOpenStoreOptions) {
    this.primary = opts.primary;
    this.breaker = opts.breaker;
    this.fallback = opts.fallback;
    this.warn = opts.warn ?? ((message) => console.warn(message));
    this.events = opts.events;
  }

  private async guard<T>(
    key: string,
    run: (s: Store) => Promise<T>,
    fallbackRun: (s: Store) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.breaker.exec(() => run(this.primary));
    } catch (err) {
      const reason = err instanceof CircuitOpenError ? 'open' : 'error';
      if (reason === 'error') {
        this.warn('rate-limiter fail-open: primary store unavailable, serving from memory');
      }
      const lastError = err instanceof Error ? err : new Error(String(err));
      this.events?.emit({ type: 'storeFallback', key, fallbackType: 'memory', reason, lastError: reason === 'error' ? lastError : undefined });
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