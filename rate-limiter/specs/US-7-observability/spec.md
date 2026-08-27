# US-7: Observability

**Requirements:** `[R10]` Logging, metrics

---

## User Story

As a platform engineer, I want to see metrics and logs for rate limiter activity, so that I can monitor usage and detect issues.

## Acceptance Criteria

- [ ] Given requests are processed, when metrics are queried, then total requests, allowed, and throttled counts are available. `[R10]`
- [ ] Given a request is throttled, when the log is written, then it includes timestamp, key, rule, and request context. `[R10]`
- [ ] Given an error occurs, when logged, then it includes error details and stack trace at the appropriate log level. `[R10]`
- [ ] Given algorithm operations, when measured, then latency metrics (count, p50, p95, p99) are tracked. `[R10]`

## Metrics to Track

### Counters

- Total requests processed
- Requests allowed
- Requests throttled
- Errors by type

### Histograms

- Algorithm check latency (p50, p95, p99)
- Store operation latency (p50, p95, p99)

## Log Events

| Event | Level | Context Required |
|-------|-------|------------------|
| Request throttled | warn | key, rule, retryAfter, ip, userId |
| Store fallback | warn | key, error, fallbackType |
| Circuit breaker opened | warn | failureCount, lastError |
| Circuit breaker closed | info | successCount |
| Algorithm error | error | key, error, stack |

## Logging Format

Structured JSON output with:
- ISO timestamp
- Log level
- Message
- Context fields (key, rule, requestId, ip, userId)

## Test Plan

### Metrics Tests

- Counter increments correctly
- Separate counters for allowed/throttled
- Histogram stores values
- Percentile calculation accurate (p50, p95, p99)
- Snapshot returns current metrics
- Metrics reset correctly

### Logging Tests

- Only logs at or above configured level
- Output is valid JSON
- Context fields included in log entry
- Timestamp present in every entry

### Integration Tests

- Throttled request produces log entry
- Store errors include stack trace
- Metrics match after 100 requests

### Edge Cases

- High throughput doesn't slow down logging
- Histogram bounded memory usage
- Concurrent metric updates
