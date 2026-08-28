import type { IncrementResult, Store } from '../domain/sliding-window';

interface Bucket {
  count: number;
  /** ms epoch when this window expires */
  expiresAt: number;
}

/** Options for {@link MemoryStore}. */
export interface MemoryStoreOptions {
  /** Time source; injectable for deterministic tests. */
  now?: () => number;
}

/**
 * In-process {@link Store} implementation.
 *
 * Keeps two fixed-window buckets per logical key (current + previous) so the
 * sliding-window limiter can read both. A bucket stays readable through the
 * *following* window (so it can serve as the weighted "previous" count) and
 * expires when that window ends. Safe under Node's single-threaded model — no
 * locks required.
 */
export class MemoryStore implements Store {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(opts: MemoryStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  private bucketKey(base: string, windowIndex: number): string {
    return `${base}:${windowIndex}`;
  }

  private prune(now: number): void {
    // ponytail: full sweep on every call is O(n). We sweep lazily only when the
    // map grows; ceiling = memory can briefly hold expired buckets between
    // sweeps. Upgrade: a small TTL heap if keys count in the millions.
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) {
        if (b.expiresAt <= now) this.buckets.delete(k);
      }
    }
  }

  /** See {@link Store.increment}. The bucket expires when the window after it ends. */
  async increment(key: string, windowMs: number, windowIndex: number): Promise<IncrementResult> {
    const now = this.now();
    this.prune(now);

    const currentKey = this.bucketKey(key, windowIndex);
    // A window's bucket must stay readable through the *following* window so the
    // limiter can weight it as the sliding "previous" count. It expires when the
    // window after it ends.
    const expiresAt = (windowIndex + 2) * windowMs;

    let current: number;
    const curBucket = this.buckets.get(currentKey);
    if (!curBucket || curBucket.expiresAt <= now) {
      current = 1;
    } else {
      current = curBucket.count + 1;
    }
    this.buckets.set(currentKey, { count: current, expiresAt });

    const prevKey = this.bucketKey(key, windowIndex - 1);
    const prevBucket = this.buckets.get(prevKey);
    const previous = prevBucket && prevBucket.expiresAt > now ? prevBucket.count : 0;

    return { current, previous };
  }

  /** See {@link Store.get}. */
  async get(key: string, windowMs: number, windowIndex: number): Promise<number> {
    const now = this.now();
    const b = this.buckets.get(this.bucketKey(key, windowIndex));
    return b && b.expiresAt > now ? b.count : 0;
  }

  /** See {@link Store.reset}. Clears every window bucket under `key`. */
  async reset(key: string): Promise<void> {
    // ponytail: iterating all keys on reset is O(n); fine because reset is rare.
    for (const k of this.buckets.keys()) {
      if (k.startsWith(`${key}:`)) this.buckets.delete(k);
    }
  }

  /** Always `true` — in-memory store cannot be unreachable. */
  async ping(): Promise<boolean> {
    return true;
  }

  /** Empties all buckets. */
  async close(): Promise<void> {
    this.buckets.clear();
  }
}