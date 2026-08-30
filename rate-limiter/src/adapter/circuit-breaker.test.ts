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

  describe('When recoveryTimeoutMs is 0', () => {
    it('opens, then probes recovery on the very next call', async () => {
      const clock = { now: 0 };
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeoutMs: 0,
        successThreshold: 1,
        now: () => clock.now,
      });

      await breaker.exec(fail()).catch(() => {});
      expect(breaker.state).toBe('OPEN');

      await expect(breaker.exec(ok('up'))).resolves.toBe('up');
      expect(breaker.state).toBe('CLOSED');
    });
  });

  describe('When the circuit reopens or probes', () => {
    it('admits only one in-flight HALF_OPEN probe; concurrent calls short-circuit', async () => {
      const clock = { now: 0 };
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeoutMs: 100,
        successThreshold: 1,
        now: () => clock.now,
      });
      await breaker.exec(fail()).catch(() => {});
      expect(breaker.state).toBe('OPEN');

      clock.now = 200; // cooldown elapsed

      let calls = 0;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const op = async () => {
        calls++;
        await gate;
        return 'ok';
      };

      const probing = breaker.exec(op); // probes recovery
      await expect(breaker.exec(op)).rejects.toThrow('Circuit is open'); // second call short-circuits
      expect(calls).toBe(1);
      expect(breaker.state).toBe('HALF_OPEN');

      release();
      await expect(probing).resolves.toBe('ok');
      expect(breaker.state).toBe('CLOSED');
    });

    it('does not re-arm the cooldown when a straggler failure lands after the trip', async () => {
      const clock = { now: 0 };
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        recoveryTimeoutMs: 1000,
        successThreshold: 1,
        now: () => clock.now,
      });

      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gatedFail = async () => {
        await gate;
        throw new Error('boom');
      };

      const straggler = breaker.exec(gatedFail); // in flight while CLOSED
      await breaker.exec(fail()).catch(() => {}); // trips -> OPEN, openedAt = 0

      clock.now = 900; // near the end of the original cooldown
      release(); // straggler fails now; it must not re-arm openedAt
      await straggler.catch(() => {});
      expect(breaker.state).toBe('OPEN');

      clock.now = 1000; // original cooldown elapses
      await expect(breaker.exec(ok('up'))).resolves.toBe('up');
      expect(breaker.state).toBe('CLOSED');
    });
  });
});
