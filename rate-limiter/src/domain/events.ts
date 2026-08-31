/**
 * Observability port: an outbound event stream describing what the library
 * did, without any opinion on how it is stored or rendered. Consumers inject
 * the same {@link Emitter} into the limiter and/or fail-open store, then
 * connect it to their own mechanisms (a log per request, a metrics
 * registry, OpenTelemetry, ...).
 */
export interface Emitter {
  emit(event: LimiterEvent): void;
}

export type LimiterEvent = CheckEvent | StoreFallbackEvent;

/** A completed rate-limit check for one item: the ruling rule's context. */
export interface CheckEvent {
  type: 'check';
  /** The ruled bucket (`bucketOf(item)` of the ruling rule). */
  bucket: string;
  /** Index of the ruling rule within the configured rules. */
  ruleIndex: number;
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the fixed window ends. Always present. */
  reset: number;
  /** Advisory back-off seconds; `undefined` when allowed. */
  retryAfter?: number;
}

/**
 * A store operation was served by the fallback instead of the primary. Emitted
 * on *every* fallback serve, so a consumer can count per-request fallback
 * usage; reporting the reason keeps the anti-log-storm design intact elsewhere.
 */
export interface StoreFallbackEvent {
  type: 'storeFallback';
  /** The bucket key being served ('ping' for the health probe). */
  key: string;
  /** The fallback store's kind. Always 'memory' today. */
  fallbackType: string;
  /** Why the primary was skipped: it threw ('error') or the circuit short-circuited ('open'). */
  reason: 'error' | 'open';
  /** The primary failure, when the primary itself threw ('error' reason). */
  lastError?: Error;
}