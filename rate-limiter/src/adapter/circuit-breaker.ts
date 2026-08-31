import type { Emitter } from '../domain/events';

/**
 * Circuit breaker lifecycle:
 *
 * - `CLOSED` — calls pass through; failures accumulate.
 * - `OPEN` — calls are short-circuited (no round trip) until the cooldown elapses.
 * - `HALF_OPEN` — one call probes the dependency to decide whether to close or reopen.
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Thrown by {@link CircuitBreaker.exec} when the circuit short-circuits: the
 * circuit is OPEN and still cooling down, or a HALF_OPEN recovery probe is
 * already in flight. Consumers distinguish it from a real dependency failure,
 * e.g. `FailOpenStore` stays silent for it instead of re-warning per request.
 */
export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit is open');
    this.name = 'CircuitOpenError';
  }
}

/** Configuration for {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** Consecutive failures in `CLOSED` that trip the circuit to `OPEN`. Must be >= 1. */
  failureThreshold: number;
  /** How long `OPEN` holds before the next call probes recovery, in milliseconds. */
  recoveryTimeoutMs: number;
  /** Successful probes in `HALF_OPEN` that close the circuit. Must be >= 1. */
  successThreshold: number;
  /** Time source; injectable for deterministic tests. */
  now?: () => number;
  /** Observability sink; receives `breakerOpened` / `breakerClosed` (optional). */
  events?: Emitter;
}

/**
 * A circuit breaker protecting calls to an unreliable dependency (Redis).
 *
 * `CLOSED` → `OPEN` after `failureThreshold` consecutive failures; `OPEN`
 * skips the call for `recoveryTimeoutMs`; `HALF_OPEN` probes recovery and
 * closes after `successThreshold` successes or reopens on the first failure.
 */
export class CircuitBreaker {
  /** Current state; start closed on a healthy dependency. */
  state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private probing = false;
  private readonly now: () => number;
  private readonly cfg: Omit<Required<CircuitBreakerOptions>, 'events'>;
  private readonly events?: Emitter;

  /**
   * @param cfg - Thresholds and cooldown for the state transitions.
   * @throws Error when thresholds are invalid (`failureThreshold`/`successThreshold` < 1, `recoveryTimeoutMs` < 0).
   */
  constructor(cfg: CircuitBreakerOptions) {
    if (cfg.failureThreshold < 1 || cfg.successThreshold < 1 || cfg.recoveryTimeoutMs < 0) {
      throw new Error('failureThreshold, successThreshold must be >= 1; recoveryTimeoutMs >= 0');
    }
    this.cfg = {
      failureThreshold: cfg.failureThreshold,
      recoveryTimeoutMs: cfg.recoveryTimeoutMs,
      successThreshold: cfg.successThreshold,
      now: cfg.now ?? Date.now,
    };
    this.now = this.cfg.now;
    this.events = cfg.events;
  }

  private transitionToOpen(failureCount: number, lastError?: Error): void {
    this.state = 'OPEN';
    this.openedAt = this.now();
    this.failures = 0;
    this.successes = 0;
    this.probing = false;
    this.events?.emit({ type: 'breakerOpened', failureCount, lastError });
  }

  /**
   * Run `op`, guarded by the circuit state.
   *
   * @param op - The guarded call (e.g. a Redis round trip).
   * @returns `op`'s result.
   * @throws {CircuitOpenError} When the circuit short-circuits without calling `op`: it is
   * `OPEN` and still cooling down, or a `HALF_OPEN` recovery probe is already in flight.
   * @throws Rethrows `op` failures (CLOSED) — on the way to `OPEN`, or reopening (HALF_OPEN).
   */
  async exec<T>(op: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt >= this.cfg.recoveryTimeoutMs) {
        this.state = 'HALF_OPEN';
      } else {
        throw new CircuitOpenError();
      }
    }

    // One in-flight probe only: with `probing` set, every concurrent call
    // short-circuits to the fallback instead of piling onto the dependency.
    if (this.state === 'HALF_OPEN') {
      if (this.probing) throw new CircuitOpenError();
      this.probing = true;
    }

    try {
      const result = await op();
      if (this.state === 'HALF_OPEN') {
        this.successes++;
        if (this.successes >= this.cfg.successThreshold) {
          this.state = 'CLOSED';
          this.events?.emit({ type: 'breakerClosed', successCount: this.successes });
          this.successes = 0;
        }
        this.probing = false;
      } else {
        this.failures = 0;
      }
      return result;
    } catch (err) {
      // A failure that lands after the circuit already tripped is a straggler
      // from CLOSED: swallowing it keeps `openedAt` un-re-armed, so a slow
      // in-flight failure cannot extend the cooldown.
      if (this.state === 'HALF_OPEN') {
        this.transitionToOpen(1, err as Error);
      } else if (this.state === 'CLOSED') {
        this.failures++;
        if (this.failures >= this.cfg.failureThreshold) {
          this.transitionToOpen(this.failures, err as Error);
        }
      }
      throw err;
    }
  }
}