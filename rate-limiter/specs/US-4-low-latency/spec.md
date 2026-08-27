# US-4: Low Latency

**Requirements:** `[R7]` Low latency, `[R8]` Low memory usage

---

## User Story

As a backend engineer, I want the rate limiter to add minimal overhead to request processing, so that response times are not noticeably degraded.

## Acceptance Criteria

- [ ] Given a rate limit check, when measured, then p99 latency is under 5ms for in-memory and under 20ms for Redis. `[R7]`
- [ ] Given a Redis operation, when it fails or times out, then the request is not blocked (fail-open). `[R7][R9]`
- [ ] Given the algorithm, when analyzed, then all operations are O(1) time and O(1) memory per key. `[R7][R8]`

## Latency Budget

| Operation | Target |
|-----------|--------|
| In-memory check | < 1ms |
| Redis check | < 5ms |
| Fail-open fallback | < 1ms |
| Middleware overhead | < 1ms |

## O(1) Algorithm Guarantees

All three algorithms must be O(1) in both time and space per key. Sliding window log (O(n)) is explicitly excluded.

## Connection Pooling

Redis connections must be pooled to avoid connection overhead per request. Pool should support configurable min/max connections and idle timeout.

## Test Plan

### Performance Tests

- 10k in-memory checks: measure p50/p95/p99
- 10k Redis checks: measure p50/p95/p99
- Max throughput before latency degrades
- Memory usage with 100k keys

### Timeout Tests

- Redis timeout completes within configured time
- Fail-open allows request when Redis is slow
- Fail-closed rejects request when configured
- Recovery after timeout

### Memory Tests

- 100k keys use predictable memory
- Expired keys don't accumulate
- No excessive object allocations

### Edge Cases

- Concurrent timeout and success
- Partial Redis response
- Memory pressure with many keys
