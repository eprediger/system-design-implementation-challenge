# US-6: Throttle Feedback

**Requirements:** `[R5]` Inform users who are throttled

---

## User Story

As a client developer, I want to receive clear, actionable feedback when my requests are throttled, so that I can implement backoff logic.

## Acceptance Criteria

- [ ] Given a throttled request, when the response is returned, then it includes HTTP status 429. `[R5]`
- [ ] Given a throttled request, when headers are inspected, then `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` are present. `[R5]`
- [ ] Given an allowed request, when headers are inspected, then `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` are present. `[R5]`
- [ ] Given a throttled request, when the body is parsed, then a JSON error object with a human-readable message is included. `[R5]`

## Response Headers

| Header | Type | When |
|--------|------|------|
| `X-RateLimit-Limit` | integer | Always |
| `X-RateLimit-Remaining` | integer | Always |
| `X-RateLimit-Reset` | integer (unix seconds) | Always |
| `Retry-After` | integer (seconds) | Only on 429 |

## Error Response Body

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 30 seconds.",
  "retryAfter": 30,
  "limit": 100,
  "remaining": 0,
  "reset": 1693000060
}
```

## Test Plan

### Unit Tests

- Allowed request sets X-RateLimit-* headers
- Allowed request calls next()
- Throttled request returns 429
- Throttled request sets Retry-After header
- All headers present on allowed request
- All headers present on throttled request
- Body matches JSON schema

### Integration Tests

- Headers update correctly across requests
- Different rules reflect correct limits
- Fail-open still sets headers

### Edge Cases

- Very large retry-after values
- Missing request properties (graceful degradation)
