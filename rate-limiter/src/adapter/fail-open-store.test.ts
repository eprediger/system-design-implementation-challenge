import { FailOpenStore } from './fail-open-store';
import { MemoryStore } from './memory-store';
import type { LimiterEvent } from '../domain/events';
import type { Store } from '../domain/ports';

const windowMs = 60_000;

function failingPrimary(increment: jest.Mock): Store {
  return {
    increment: increment,
    get: jest.fn().mockResolvedValue(0),
    reset: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Given a fail-open store whose primary is down', () => {
  it('serves from the fallback and warns when the primary fails', async () => {
    const warns: string[] = [];
    const clock = { now: 0 };
    const store = new FailOpenStore({
      primary: failingPrimary(jest.fn().mockRejectedValue(new Error('redis down'))),
      failureThreshold: 2,
      recoveryTimeoutMs: 60_000,
      successThreshold: 1,
      now: () => clock.now,
      fallback: new MemoryStore({ now: () => clock.now }),
      warn: (m) => warns.push(m),
    });

    await expect(store.increment('k', windowMs, 0)).resolves.toEqual({ current: 1, previous: 0 });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('fail-open');
  });

  it('stops calling the primary once the circuit is open', async () => {
    const increment = jest.fn().mockRejectedValue(new Error('redis down'));
    const clock = { now: 0 };
    const store = new FailOpenStore({
      primary: failingPrimary(increment),
      failureThreshold: 2,
      recoveryTimeoutMs: 60_000,
      successThreshold: 1,
      now: () => clock.now,
      fallback: new MemoryStore({ now: () => clock.now }),
      warn: () => {},
    });

    await store.increment('k', windowMs, 0); // consecutive failure 1
    await store.increment('k', windowMs, 0); // consecutive failure 2 -> OPEN
    await store.increment('k', windowMs, 0); // OPEN: primary skipped, fallback serves
    expect(increment).toHaveBeenCalledTimes(2);
  });

  it('re-uses the primary once it recovers through a half-open probe', async () => {
    let healthy = false;
    const increment = jest.fn(async () => {
      if (!healthy) throw new Error('redis down');
      return { current: 1, previous: 0 };
    });
    const clock = { now: 0 };
    const fallback = new MemoryStore({ now: () => clock.now });
    const store = new FailOpenStore({
      primary: failingPrimary(increment),
      failureThreshold: 2,
      recoveryTimeoutMs: 1000,
      successThreshold: 1,
      now: () => clock.now,
      fallback,
      warn: () => {},
    });

    await store.increment('k', windowMs, 0); // outage, served from fallback
    await store.increment('k', windowMs, 0); // outage, served from fallback
    // After 2 failures, circuit is OPEN; primary is skipped

    clock.now = 2000; // cooldown elapses, circuit enters HALF_OPEN
    healthy = true;

    await store.increment('k', windowMs, 0); // half-open probe succeeds -> CLOSED
    // After circuit closes, primary is used again
    await store.increment('k', windowMs, 0); // healthy: primary only
    expect(increment).toHaveBeenCalledTimes(4);

    // fallback served the two outage hits and nothing since
    await expect(fallback.get('k', windowMs, 0)).resolves.toBe(2);
  });

  it('emits a storeFallback event per fallback serve with its reason', async () => {
    const events: LimiterEvent[] = [];
    const clock = { now: 0 };
    const store = new FailOpenStore({
      primary: failingPrimary(jest.fn().mockRejectedValue(new Error('redis down'))),
      failureThreshold: 2,
      recoveryTimeoutMs: 60_000,
      successThreshold: 1,
      now: () => clock.now,
      fallback: new MemoryStore({ now: () => clock.now }),
      warn: () => {},
      events: { emit: (e) => events.push(e) },
    });

    await store.increment('k', windowMs, 0); // failure 1 -> error serve
    await store.increment('k', windowMs, 0); // failure 2 -> trips -> error serve
    await store.increment('k', windowMs, 0); // OPEN: fallback serve, reason 'open'
    expect(events).toEqual([
      { type: 'storeFallback', key: 'k', fallbackType: 'memory', reason: 'error', lastError: expect.any(Error) },
      { type: 'storeFallback', key: 'k', fallbackType: 'memory', reason: 'error', lastError: expect.any(Error) },
      { type: 'storeFallback', key: 'k', fallbackType: 'memory', reason: 'open', lastError: undefined },
    ]);
  });
});