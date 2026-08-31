import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BucketRule, Emitter, LimiterEvent } from 'rate-limiter';
import type { Request } from 'express';
import type { AppLogger } from './logger';
import type { DemoMetrics } from './metrics';

/** One context-rich log line per request, written once when the response finishes. */
export interface WideEvent {
  request_id: string;
  method: string;
  path: string;
  ip: string;
  user_id?: string;
  status_code?: number;
  duration_ms?: number;
  rate_limit?: {
    bucket: string;
    rule?: { window_ms: number; max_requests: number };
    allowed: boolean;
    limit: number;
    remaining: number;
    reset: number;
    retry_after?: number;
  };
  store?: { served_from: string; reason: 'error' | 'open'; error?: string };
  error?: { type: string; message: string; stack?: string };
}

/** Carries the in-flight request's {@link WideEvent} to the singleton emitter and error handler. */
export const requestCtx = new AsyncLocalStorage<{ wide: WideEvent }>();

export function newWideEvent(req: Request): WideEvent {
  return {
    request_id: req.get('X-Request-Id') ?? randomUUID(),
    method: req.method,
    path: req.path,
    ip: req.ip ?? 'unknown',
    user_id: req.get('X-User-Id') ?? undefined,
  };
}

/** Maps {@link LimiterEvent}s from the library onto metrics counters and the in-flight wide event. */
export function createEmitter(
  metrics: DemoMetrics,
  logger: AppLogger,
  rules: ReadonlyArray<BucketRule<Request>>,
): Emitter {
  return {
    emit(event: LimiterEvent): void {
      const ctx = requestCtx.getStore();
      switch (event.type) {
        case 'check': {
          const ruleLabels = ['global', 'per-ip', 'per-ip:endpoint'];
          metrics.requestsTotal.inc({ rule: ruleLabels[event.ruleIndex] });
          if (event.allowed) metrics.allowedTotal.inc({ rule: ruleLabels[event.ruleIndex] });
          else metrics.throttledTotal.inc({ rule: ruleLabels[event.ruleIndex] });
          const rule = rules[event.ruleIndex]?.rule;
          if (ctx) {
            ctx.wide.rate_limit = {
              bucket: event.bucket,
              rule: rule ? { window_ms: rule.windowMs, max_requests: rule.maxRequests } : undefined,
              allowed: event.allowed,
              limit: event.limit,
              remaining: event.remaining,
              reset: event.reset,
              retry_after: event.retryAfter,
            };
          }
          break;
        }
        case 'storeFallback': {
          metrics.fallbackTotal.inc({ reason: event.reason });
          if (ctx) {
            ctx.wide.store = {
              served_from: event.fallbackType,
              reason: event.reason,
              error: event.lastError?.message,
            };
          }
          break;
        }
        case 'breakerOpened':
          metrics.breakerOpenedTotal.inc();
          logger.warn(
            { breaker: 'open', failure_count: event.failureCount, last_error: event.lastError?.message },
            'circuit breaker opened',
          );
          break;
        case 'breakerClosed':
          logger.info({ breaker: 'closed', success_count: event.successCount }, 'circuit breaker closed');
          break;
      }
    },
  };
}