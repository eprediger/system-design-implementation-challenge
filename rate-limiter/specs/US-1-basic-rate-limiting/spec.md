# US-1: Basic Rate Limiting

**Requirements:** `[R1]` Server-side API rate limiter, `[R6]` Accurately limit excessive requests

---

## User Story

As a system administrator, I want to limit the number of requests a client can make within a time window, so that I protect backend services from abuse.

## Acceptance Criteria

- [ ] Given a client has not exceeded their limit, when they make a request, then it is allowed and `X-RateLimit-*` headers are returned. `[R1][R5]`
- [ ] Given a client exceeds the limit, when they make a request, then it returns HTTP 429 with `Retry-After` header. `[R1][R5]`
- [ ] Given the time window resets, when the client makes a request, then the counter resets and the request is allowed. `[R6]`

## Algorithms

Three algorithms are required, each with different trade-offs:

| Algorithm | Precision | Memory | Burst Handling |
|-----------|-----------|--------|----------------|
| Fixed Window | Low (boundary burst) | Minimal | Poor |
| Sliding Window | High | Minimal | Moderate |
| Token Bucket | Medium | Minimal | Excellent |

## Test Plan

### Unit Tests

- Allow within limit
- Throttle at limit
- Window reset
- Boundary test (exact limit)
- Zero limit (all rejected)
- Single request
- Result contains all required fields

### Edge Cases

- Request at exact window transition
- Concurrent requests at same timestamp
