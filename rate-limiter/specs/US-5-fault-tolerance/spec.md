# US-5: Fault Tolerance

**Requirements:** `[R9]` High fault tolerance (circuit breaker, fail-open)

---

## User Story

As a platform engineer, I want the rate limiter to degrade gracefully when Redis is unavailable, so that the system remains available even if the rate limiter infrastructure fails.

## Acceptance Criteria

- [ ] Given Redis is unreachable, when a request arrives, then it falls back to in-memory rate limiting. `[R9]`
- [ ] Given Redis has been down for multiple consecutive failures, when detected, then the circuit breaker opens and subsequent checks skip Redis. `[R9]`
- [ ] Given Redis recovers, when healthy checks succeed, then the circuit breaker closes and Redis is re-used. `[R9]`
- [ ] Given a failure, when it occurs, then it is logged and metrics are updated. `[R9][R10]`

## Circuit Breaker States

```
CLOSED (normal) → OPEN (fallback) → HALF-OPEN (testing)
     ↑                                    │
     └──────── success ──────────────────┘
```

- **CLOSED**: Normal operation, requests go to Redis
- **OPEN**: Circuit tripped, requests use in-memory fallback
- **HALF-OPEN**: Testing recovery, limited requests to Redis

## Circuit Breaker Behavior

- Opens after N consecutive failures (configurable)
- Waits configurable timeout before trying again
- Closes after M successful checks in half-open state
- Reopens immediately on failure during half-open

## Fail-Open Strategy

When circuit is open or store operation fails:

1. Log the failure at WARN level
2. Increment failure metric
3. Fall back to in-memory rate limiting
4. Allow the request (fail-open)

## Test Plan

### Circuit Breaker Tests

- Closed → Open after N failures
- Open blocks calls (throws error)
- Open → Half-Open after timeout
- Half-Open → Closed after M successes
- Half-Open → Open on failure
- Success resets failure counter

### Integration Tests

- Redis down triggers fallback
- Redis recovery closes circuit
- Concurrent failures open circuit correctly
- Recovery during load works

### Edge Cases

- Circuit opens during half-open check
- Clock skew between servers
- Memory pressure during fallback
- Multiple simultaneous failures
