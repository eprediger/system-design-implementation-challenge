import { MemoryStore } from './memory-store';

describe('Given an in-memory store', () => {
  let now: number;
  let store: MemoryStore;

  beforeEach(() => {
    now = 0;
    store = new MemoryStore({ now: () => now });
  });

  describe('Given a new key in window 0', () => {
    it('increment creates the current count at 1 with previous 0', async () => {
      const res = await store.increment('key', 60_000, 0);
      expect(res.current).toBe(1);
      expect(res.previous).toBe(0);
    });

    it('get returns 0 for a missing key', async () => {
      expect(await store.get('missing', 60_000, 0)).toBe(0);
    });
  });

  describe('Given an existing key', () => {
    beforeEach(async () => {
      await store.increment('key', 60_000, 0);
      await store.increment('key', 60_000, 0);
    });

    it('increment increases the current count', async () => {
      const res = await store.increment('key', 60_000, 0);
      expect(res.current).toBe(3);
    });

    it('get returns the current count', async () => {
      expect(await store.get('key', 60_000, 0)).toBe(2);
    });
  });

  describe('Given the window resets', () => {
    it('keeps the previous window readable while the current window is active', async () => {
      await store.increment('key', 60_000, 0);
      now = 60_001;
      expect(await store.get('key', 60_000, 0)).toBe(1);
    });

    it('expires a window bucket only after the following window ends', async () => {
      await store.increment('key', 60_000, 0);
      now = 119_999;
      expect(await store.get('key', 60_000, 0)).toBe(1);
      now = 120_001;
      expect(await store.get('key', 60_000, 0)).toBe(0);
    });

    it('moves the current count into the previous window and starts fresh', async () => {
      await store.increment('key', 60_000, 0);
      await store.increment('key', 60_000, 0);
      now = 60_001;
      const res = await store.increment('key', 60_000, 1);
      expect(res.current).toBe(1);
      expect(res.previous).toBe(2);
    });
  });

  describe('Given a stored key', () => {
    it('reset clears it', async () => {
      await store.increment('key', 60_000, 0);
      await store.reset('key');
      expect(await store.get('key', 60_000, 0)).toBe(0);
    });
  });

  describe('ping', () => {
    it('returns true', async () => {
      expect(await store.ping()).toBe(true);
    });
  });

  describe('independent keys', () => {
    it('counters for different keys do not interfere', async () => {
      await store.increment('a', 60_000, 0);
      await store.increment('a', 60_000, 0);
      await store.increment('b', 60_000, 0);
      expect(await store.get('a', 60_000, 0)).toBe(2);
      expect(await store.get('b', 60_000, 0)).toBe(1);
    });
  });
});
