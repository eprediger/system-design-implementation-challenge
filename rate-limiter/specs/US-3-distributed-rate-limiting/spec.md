# US-3: Distributed Rate Limiting

**Requirements:** `[R4]` Distributed environment, `[R3]` Handle large number of requests

---

## User Story

As a platform engineer, I want the rate limiter to share state across multiple server instances, so that clients cannot bypass limits by hitting different servers.

## Acceptance Criteria

- [ ] Given two server instances with Redis, when a client hits both, then the counter is shared and limits are enforced globally. `[R4]`
- [ ] Given a Redis operation, when it completes, then it uses atomic operations (no race conditions). `[R4][R11]`
- [ ] Given a distributed deployment, when tested with 10,000+ concurrent requests, then limits are enforced accurately. `[R3][R4]`

## Store Interface

The store abstraction must support:

- Increment a counter with TTL
- Get current count
- Reset a key
- Set a key to a specific value with TTL
- Health check (ping)
- Cleanup (close)

## Redis Atomicity

Sliding window and token bucket algorithms require Redis Lua scripts to ensure atomicity. Single Redis commands (INCR, EXPIRE) are not sufficient for multi-step operations.

## Test Plan

### Unit Tests

- Increment creates new key at 1
- Increment increases existing key
- Key expires after TTL
- Get returns current count
- Get returns 0 for missing key
- Reset clears key
- Ping returns true/false

### Integration Tests (Redis)

- 100 concurrent increments produce exact count
- TTL correctness
- Lua script sliding window matches expected
- Lua script token bucket matches expected

### Load Tests

- 10k concurrent increments complete
- 1000 ops/sec sustained for 10 seconds
- 100 different keys remain independent
- Graceful degradation under load

### Edge Cases

- Redis connection drops mid-operation
- Redis command timeout
- Special characters in keys
- Large window values
