import { CircuitBreaker } from './circuit-breaker';

function ok<T>(v: T): () => Promise<T> {
  return () => Promise.resolve(v);
}
function fail(): () => Promise<never> {
  return () => Promise.reject(new Error('redis down'));
}

describe('Given a circuit breaker', () => {
  describe('When the circuit is CLOSED', () => {
    let breaker: CircuitBreaker;
    beforeEach(() => {
      breaker = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 1000, successThreshold: 2 });
    });

    it('executes the operation and returns its result', async () => {
      await expect(breaker.exec(ok('yes'))).resolves.toBe('yes');
    });

    it('stays CLOSED until failureThreshold consecutive failures', async () => {
      await breaker.exec(fail()).catch(() => {});
      await breaker.exec(fail()).catch(() => {});
      await breaker.exec(ok('still works'));
      await breaker.exec(fail()).catch(() => {});
      await breaker.exec(fail()).catch(() => {});
      await expect(breaker.exec(ok('closed'))).resolves.toBe('closed');
    });

    it('opens after failureThreshold consecutive failures', async () => {
      await breaker.exec(fail()).catch(() => {});
      await breaker.exec(fail()).catch(() => {});
      await breaker.exec(fail()).catch(() => {});
      expect(breaker.state).toBe('OPEN');
    });
  });

  describe('When the circuit is OPEN', () => {
    let breaker: CircuitBreaker;
    beforeEach(async () => {
      breaker = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 1000, successThreshold: 1 });
      await breaker.exec(fail()).catch(() => {});
      await breaker.exec(fail()).catch(() => {});
      expect(breaker.state).toBe('OPEN');
    });

    it('throws without calling the operation', async () => {
      await expect(breaker.exec(fail())).rejects.toThrow('open');
    });

    it('stays OPEN until the cooldown passes, then probes on the next call', async () => {
      await new Promise((r) => setTimeout(r, 1100));
      // A call after the cooldown probes Redis (HALF-OPEN). A success closes it.
      await expect(breaker.exec(ok('recovered'))).resolves.toBe('recovered');
      expect(breaker.state).toBe('CLOSED');
    });
  });

  describe('When the circuit is HALF-OPEN', () => {
    let breaker: CircuitBreaker;
    beforeEach(async () => {
      breaker = new CircuitBreaker({ failureThreshold: 2, recoveryTimeoutMs: 50, successThreshold: 2 });
      await breaker.exec(fail()).catch(() => {});
      await breaker.exec(fail()).catch(() => {});
      expect(breaker.state).toBe('OPEN');
      // Drive the lazy OPEN -> HALF-OPEN probe by making a call after cooldown.
      await new Promise((r) => setTimeout(r, 150));
    });

    it('closes after successThreshold successful checks', async () => {
      await breaker.exec(ok('a'));
      await breaker.exec(ok('b'));
      expect(breaker.state).toBe('CLOSED');
    });

    it('reopens immediately on a failure', async () => {
      await breaker.exec(ok('a'));
      await expect(breaker.exec(fail())).rejects.toThrow();
      expect(breaker.state).toBe('OPEN');
    });
  });

  describe('Config validation', () => {
    it('requires a positive failureThreshold', () => {
      expect(() => new CircuitBreaker({ failureThreshold: 0, recoveryTimeoutMs: 1, successThreshold: 1 })).toThrow();
    });
  });
});
