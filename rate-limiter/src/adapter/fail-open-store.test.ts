import { FailOpenStore } from './fail-open-store';
import { CircuitBreaker } from './circuit-breaker';
import { MemoryStore } from './memory-store';
import type { Store } from '../domain/ports';

const windowMs = 60_000;
const liveIndex = Math.floor(Date.now() / windowMs);

function failingPrimary(increment: jest.Mock): Store {
  return {
    increment,
    get: jest.fn().mockResolvedValue(0),
    reset: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue(true),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('Given a fail-open store whose primary is down', () => {
  it('serves from the fallback and warns when the primary fails', async () => {
    const warns: string[] = [];
    const store = new FailOpenStore({
      primary: failingPrimary(jest.fn().mockRejectedValue(new Error('redis down'))),
      breaker: new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 60_000, successThreshold: 1 }),
      fallback: new MemoryStore(),
      warn: (m) => warns.push(m),
    });

    await expect(store.increment('k', windowMs, liveIndex)).resolves.toEqual({ current: 1, previous: 0 });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('fail-open');
  });

  it('stops calling the primary once the circuit is open', async () => {
    const increment = jest.fn().mockRejectedValue(new Error('redis down'));
    const store = new FailOpenStore({
      primary: failingPrimary(increment),
      breaker: new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 60_000, successThreshold: 1 }),
      fallback: new MemoryStore(),
      warn: () => {},
    });

    await store.increment('k', windowMs, liveIndex); // consecutive failure 1
    await store.increment('k', windowMs, liveIndex); // consecutive failure 2 → OPEN
    await store.increment('k', windowMs, liveIndex); // OPEN: primary skipped, fallback serves
    expect(increment).toHaveBeenCalledTimes(2);
  });

  it('re-uses the primary once it recovers through a half-open probe', async () => {
    let healthy = false;
    const increment = jest.fn(async () => {
      if (!healthy) throw new Error('redis down');
      return { current: 1, previous: 0 };
    });
    const clock = { now: 0 };
    const fallback = new MemoryStore();
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeoutMs: 1000,
      successThreshold: 1,
      now: () => clock.now,
    });
    const store = new FailOpenStore({
      primary: failingPrimary(increment),
      breaker,
      fallback,
      warn: () => {},
    });

    await store.increment('k', windowMs, liveIndex); // outage, served from fallback
    await store.increment('k', windowMs, liveIndex); // outage, served from fallback
    expect(breaker.state).toBe('OPEN');

    clock.now = 2000; // cooldown elapses
    healthy = true;

    await store.increment('k', windowMs, liveIndex); // half-open probe succeeds → CLOSED
    expect(breaker.state).toBe('CLOSED');
    await store.increment('k', windowMs, liveIndex); // healthy: primary only
    expect(increment).toHaveBeenCalledTimes(4);

    // fallback served the two outage hits and nothing since
    await expect(fallback.get('k', windowMs, liveIndex)).resolves.toBe(2);
  });
});