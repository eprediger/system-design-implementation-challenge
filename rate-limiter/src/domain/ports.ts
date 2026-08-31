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
   * Must be atomic per key so concurrent hits never lose a count.
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

  /** Health probe for operators/monitoring; `true` when the store responds. */
  ping(): Promise<boolean>;

  /** Release underlying resources (e.g. connections). */
  close(): Promise<void>;
}