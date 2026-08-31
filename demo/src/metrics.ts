import { Counter, Registry, Summary } from 'prom-client';
import type { Store } from 'rate-limiter';

export interface DemoMetrics {
  registry: Registry;
  requestsTotal: Counter<string>;
  allowedTotal: Counter<string>;
  throttledTotal: Counter<string>;
  errorsTotal: Counter<string>;
  fallbackTotal: Counter<string>;
  checkMs: Summary<string>;
  storeOpMs: Summary<string>;
}

export function createMetrics(): DemoMetrics {
  const registry = new Registry();
  const counter = (name: string, help: string, labelNames: string[] = []) =>
    new Counter({ name, help, labelNames, registers: [registry] });
  const summary = (name: string, help: string, labelNames: string[] = []) =>
    new Summary({ name, help, labelNames, percentiles: [0.5, 0.95, 0.99], registers: [registry] });
  return {
    registry,
    requestsTotal: counter('rate_limit_requests_total', 'Total requests processed', ['rule']),
    allowedTotal: counter('rate_limit_allowed_total', 'Requests allowed', ['rule']),
    throttledTotal: counter('rate_limit_throttled_total', 'Requests throttled', ['rule']),
    errorsTotal: counter('rate_limit_errors_total', 'Errors by type', ['type']),
    fallbackTotal: counter('rate_limit_fallback_total', 'Store fallback serves', ['reason']),
    checkMs: summary('rate_limit_check_ms', 'Algorithm check latency (ms)'),
    storeOpMs: summary('rate_limit_store_op_ms', 'Store operation latency (ms)', ['operation']),
  };
}

/** Wrap a {@link Store} so every operation feeds the store-latency histogram. */
export function timedStore(store: Store, observed: Summary<string>): Store {
  const timed = <T>(operation: string, run: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    return run().finally(() => observed.observe({ operation }, performance.now() - started));
  };
  return {
    increment: (key, windowMs, windowIndex) => timed('increment', () => store.increment(key, windowMs, windowIndex)),
    get: (key, windowMs, windowIndex) => timed('get', () => store.get(key, windowMs, windowIndex)),
    reset: (key) => timed('reset', () => store.reset(key)),
    ping: () => timed('ping', () => store.ping()),
    close: () => store.close(),
  };
}