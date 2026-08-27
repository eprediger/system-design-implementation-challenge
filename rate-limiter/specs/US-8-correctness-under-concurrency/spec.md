# US-8: Correctness Under Concurrency

**Requirements:** `[R11]` Correct, well-designed, tested, `[R3]` Handle large number of requests

---

## User Story

As a system architect, I want comprehensive tests that validate correctness under concurrent load, so that I can trust the implementation in production.

## Acceptance Criteria

- [ ] Given 100 concurrent requests with a limit of 50, when all are submitted simultaneously, then exactly 50 are allowed and 50 are throttled. `[R11][R3]`
- [ ] Given a sliding window transition, when requests arrive at window boundaries, then counts are accurate. `[R11][R6]`
- [ ] Given token bucket with burst capacity, when a burst arrives, then allowed tokens are consumed correctly. `[R11][R6]`
- [ ] Given all algorithms, when tested, then edge cases (zero limit, single request, window reset timing) are covered. `[R11]`

## Concurrency Test Strategy

All concurrent tests must use `Promise.all` to submit requests simultaneously, not sequentially. This validates atomic operations and race condition handling.

## Test Scenarios

### Concurrent Throttling

100 concurrent requests with limit 50 → exactly 50 allowed, 50 throttled.

### Window Boundary

Requests arriving at exact window transition → counter resets at correct time.

### Token Bucket Burst

Full burst capacity consumed immediately → tokens deplete correctly.

### Load Test Configuration

- 10,000 total requests
- 100 concurrent
- 100 limit per key
- 10 different keys
- 60-second window

## Test Plan

### Concurrency Tests

- 100 concurrent, limit 50 → exactly 50 allowed
- 1000 concurrent, limit 100 → exactly 100 allowed
- 10k total, 100 concurrency → all processed, limits enforced
- Multiple keys → independent counters

### Boundary Tests

- Window transition resets counter
- Exact limit boundary correct
- Clock skew tolerance

### Burst Tests

- Token bucket full burst consumed
- Token bucket refill rate correct
- Burst across keys independent

### Stress Tests

- 100k requests → memory doesn't grow
- Sustained load → latency stable
- Memory pressure → keys don't accumulate

### Edge Cases

- Zero limit → all throttled
- Single request → first allowed, second throttled
- Empty key → works
- Long key → no memory issues
- Unicode key → handles special characters

## Test Environment

- In-memory store: No dependencies
- Redis store: Use testcontainers or skip if unavailable
- Load tests: Run separately (not in CI)
