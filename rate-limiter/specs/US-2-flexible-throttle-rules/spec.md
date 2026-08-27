# US-2: Flexible Throttle Rules

**Requirements:** `[R2]` Flexible throttle rules (IP, user ID, extensible)

---

## User Story

As a system administrator, I want to configure different rate limit rules based on client properties (IP, user ID, API key), so that I can apply granular policies.

## Acceptance Criteria

- [ ] Given a rule keyed by IP, when two requests come from the same IP, then they share a counter. `[R2]`
- [ ] Given a rule keyed by user ID, when two requests come from different users, then they have separate counters. `[R2]`
- [ ] Given a custom key extractor, when provided, then it is used to derive the rate limit key. `[R2]`
- [ ] Given multiple rules, when a request matches, then all rules are evaluated. `[R2]`

## Key Extractors

Built-in extractors to support:

- **byIP**: Rate limit by client IP address
- **byUserID**: Rate limit by authenticated user ID
- **byAPIKey**: Rate limit by API key (header or context)
- **byPath**: Rate limit by request method and path
- **composite**: Combine multiple extractors

## Predefined Rule Sets

- **Standard API**: 100 req/min per IP
- **Auth Endpoints**: 10 req/min per IP (stricter)
- **User-Based**: 1000 req/hour per user

## Test Plan

### Unit Tests

- byIP extractor returns correct key format
- byUserID extractor returns correct key format
- byUserID throws when user ID missing
- byAPIKey extractor from context
- byAPIKey extractor from header
- byAPIKey throws when key missing
- byPath combines method and path
- composite combines extractors

### Rule Evaluation

- Single rule produces single result
- Multiple rules produce multiple results
- Non-matching extractor handled gracefully
