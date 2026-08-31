export { RateLimitResult } from './domain/rate-limit-result';
export {
  RateLimiterConfigurationError,
  SlidingWindowLimiter,
} from './domain/sliding-window';
export type {
  BucketRule,
  RateLimitRule,
  SlidingWindowLimiterOptions,
} from './domain/sliding-window';
export type { Clock, IncrementResult, Store } from './domain/ports';
export type { Emitter, LimiterEvent } from './domain/events';
export { CircuitBreaker, CircuitOpenError } from './adapter/circuit-breaker';
export type { CircuitBreakerOptions, CircuitState } from './adapter/circuit-breaker';
export { MemoryStore } from './adapter/memory-store';
export type { MemoryStoreOptions } from './adapter/memory-store';
export { FailOpenStore } from './adapter/fail-open-store';
export type { FailOpenStoreOptions } from './adapter/fail-open-store';
export { RedisStore } from './adapter/redis';