/**
 * Circuit breaker lifecycle:
 *
 * - `CLOSED` — calls pass through; failures accumulate.
 * - `OPEN` — calls are short-circuited (no round trip) until the cooldown elapses.
 * - `HALF_OPEN` — one call probes the dependency to decide whether to close or reopen.
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

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
  private readonly now: () => number;
  private readonly cfg: Required<CircuitBreakerOptions>;

  /**
   * @param cfg - Thresholds and cooldown for the state transitions.
   * @throws Error when thresholds are invalid (`failureThreshold`/`successThreshold` < 1, `recoveryTimeoutMs` < 0).
   */
  constructor(cfg: CircuitBreakerOptions) {
    if (cfg.failureThreshold < 1 || cfg.successThreshold < 1 || cfg.recoveryTimeoutMs < 0) {
      throw new Error('failureThreshold, successThreshold must be >= 1; recoveryTimeoutMs >= 0');
    }
    this.cfg = { ...cfg, now: cfg.now ?? Date.now };
    this.now = this.cfg.now;
  }

  private transitionToOpen(): void {
    this.state = 'OPEN';
    this.openedAt = this.now();
    this.failures = 0;
    this.successes = 0;
  }

  /**
   * Run `op`, guarded by the circuit state.
   *
   * @param op - The guarded call (e.g. a Redis round trip).
   * @returns `op`'s result.
   * @throws When the circuit is `OPEN` and still cooling down, without calling `op`; rethrows `op` failures.
   */
  async exec<T>(op: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt >= this.cfg.recoveryTimeoutMs) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('Circuit is open');
      }
    }

    try {
      const result = await op();
      if (this.state === 'HALF_OPEN') {
        this.successes++;
        if (this.successes >= this.cfg.successThreshold) {
          this.state = 'CLOSED';
          this.successes = 0;
        }
      } else {
        this.failures = 0;
      }
      return result;
    } catch (err) {
      if (this.state === 'HALF_OPEN') {
        this.transitionToOpen();
      } else {
        this.failures++;
        if (this.failures >= this.cfg.failureThreshold) {
          this.transitionToOpen();
        }
      }
      throw err;
    }
  }
}