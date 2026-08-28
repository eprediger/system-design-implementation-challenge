# DESIGN — Server-Side API Rate Limiter

> **Status: WIP.** This document is a living record, updated as decisions are made
> during implementation. It is not a post-hoc write-up.

## TL;DR

- **Language/stack:** TypeScript on Node.js, Express, ioredis, Jest
- **Algorithm:** Sliding window counter (O(1) time/space per key)
- **Storage:** `Store` interface — Redis-backed (atomic Lua) with in-memory fallback
- **Resilience:** Circuit breaker (closed → open → half-open), fail-open
- **Rules:** Global, per-IP, per-endpoint `pathPattern` — no extractor/plugin system

---

## 1. Goals & Non-Goals

### Goals

- Accurately limit excessive requests
- Low latency (in-memory < 1ms, Redis < 5ms target)
- Distributed (shared state across server instances via Redis)
- High fault tolerance (Redis outage → in-memory fallback, fail-open)
- Low memory (O(1) per key)
- Clear throttle feedback (429 + `X-RateLimit-*` headers + JSON body)
- Built and tested BDD/TDD-style, before implementation

### Non-Goals (deliberately cut)

- **Multiple algorithms** (specs list three — we ship one, sliding window counter)
- **Extractor/plugin system** — three rules, keys derived inline
- **Schema-validation library** — TS types cover config; Express parses request fields
- **(Roadmap)** Prometheus-format `/metrics` endpoint; Grafana dashboard

---

## 2. Architecture

```
Request → Express Middleware → extract key(s) → RateLimiter.check(key, rule) → Response
                                                          │
                                                    CircuitBreaker
                                                    Redis ⇄ in-memory fallback
```

### Component map

| Component | File | Responsibility |
|-----------|------|----------------|
| Rules | `rules.ts` | Define global / per-IP / per-endpoint limits |
| Middleware | `middleware.ts` | Extract key, run checks, set headers, return 429 |
| Algorithm | `sliding-window.ts` | Window math, decision logic |
| Store (interface) | `store/interface.ts` | Uniform storage contract |
| Redis store | `store/redis.ts` | Atomic Lua scripts, shared state |
| Memory store | `store/memory.ts` | In-process fallback (Map + expiry) |
| Circuit breaker | `circuit-breaker.ts` | Closed/Open/Half-open state machine |

---

## 3. Algorithm: Sliding Window Counter

### Decision

We evaluated **five** candidate algorithms against the concrete requirements,
and chose **sliding window counter**. All state is O(1) per key; requests are
answered with an immediate allow/deny; and the "exactly N allowed per window"
acceptance criteria (US-1, US-8) hold.

| Algorithm | Precision | Memory | Allow/deny | Distributed (Redis) | Verdict |
|-----------|-----------|--------|-----------|---------------------|---------|
| Fixed Window Counter | Low | O(1) | Immediate | Simple single counter | **Rejected** — boundary burst |
| Sliding Window Log | High | **O(n)/key** | Immediate | Sorted set, O(n) per key | **Rejected** — violates O(1) memory |
| Token Bucket | Medium | O(1) | Immediate | Needs atomic refill state | **Rejected** — allows bursts, conflicts with strict window |
| Leaking Bucket | High | **O(burst)/key** | **Delays/queues** | Complex queue state | **Rejected** — queues instead of denying; breaks low latency |
| **Sliding Window Counter** | **High** | **O(1)** | **Immediate** | **Atomic two-counter Lua** | **Chosen** |

### Why each rejected algorithm does not fit our requirements

- **Fixed window counter** — the classic low-precision option. A client can make
  `2 × maxRequests` requests across a window boundary (the "boundary burst"). For
  a limiter whose job is to *accurately* limit (US-1, R6), this is unacceptable.

- **Sliding window log** — the most precise, but it stores a timestamp per
  request, making it O(n) in memory per key. This directly violates the low-memory
  requirement (R8: O(1) per key). Also O(n) work per check. Both of these are
  disqualifying at the "large number of requests" scale (R3).

- **Sliding window counter** — **chosen.** Achieves the same *precision* as the
  sliding-window log, but with only **two counters** per key (current + previous
  window) and a weighted blend — O(1) time and O(1) memory. A single atomic Redis
  operation returns both counters, so it is trivially distributed (US-3) with no
  race conditions. The blend is only approximate, but the error is bounded and
  negligible for even limits.

- **Token bucket** — allows sustained bursts up to capacity and smooths load. That
  burst tolerance is a feature for shaping *downstream* traffic, but it directly
  conflicts with our strict "no more than N requests in a window" acceptance
  criteria (US-8: exactly 50 of 100 allowed). It also needs to store and atomically
  refill two interdependent values (tokens + refill timestamp), more state than the
  two independent counters. It's the strongest runner-up; we'd switch to it only if
  we needed to *smooth* bursts rather than strictly *gate* them.

- **Leaking bucket** — its core mechanism is a queue of pending requests drained at
  a constant rate. That means requests are *delayed* rather than immediately allowed
  or denied. An HTTP gateway cannot hold a request for seconds without wrecking
  p99 latency (US-4), and the queue is O(burst) memory (violates R8). It is a
  **scheduling/queuing** tool, not a **gating** tool — the wrong shape for a 429
  rate limiter.

### How it works

Time is divided into fixed windows of `windowMs`. For a request at time `T` in
window index `cur`, the effective usage blends the previous window's count
(decaying as we move through the window) with the current window's count:

```
index          = floor(T / windowMs)
sectionWeight  = elapsedInWindow / windowMs        // 0 at window start → 1 at end
effectiveCount = prevWindowCount * (1 - sectionWeight) + currWindowCount
allowed        = effectiveCount <= maxRequests
```

- **Redis:** one atomic Lua script reads, increments, and expires both counters in
  a single round trip (no race conditions, single network hop).
- **Memory:** two counters per key plus a cheap lazy expiry sweep.

---

## 4. Rules

Three hard-coded rules; keys derived in the middleware, not via a plugin system:

```ts
{ key: 'global',        windowMs: 60_000, maxRequests: 1000                  }
{ key: 'ip',            windowMs: 60_000, maxRequests: 100                   }
{ key: 'auth-route',    windowMs: 60_000, maxRequests: 10, pathPattern: '/api/auth/*' }
```

### Why no extractor system

The spec suggests `byIP` / `byUserID` / `byAPIKey` / `byPath` / `composite`
extractors. For our three rules the "extractor" is trivial: `req.ip`, `req.path`,
or a constant. A class hierarchy for key derivation is over-engineering.

---

## 5. Store Interface

```ts
interface Store {
  increment(key: string, windowMs: number): Promise<{ count: number; ttl: number }>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
```

Two implementations: Redis (atomic, shared) and in-memory (fallback). The
interface is deliberately small — only what the sliding-window algorithm needs.
The spec lists `set(key, value, ttl)` as a method; we cut it because sliding
window never needs unconditional sets.

---

## 6. Circuit Breaker

```
CLOSED (healthy) --N failures--> OPEN (fallback) --timeout--> HALF-OPEN (test) --M successes--> CLOSED
      ^                                                                                 │
      └──────────────────────────── failure reopens → ─────────────────────────────────┘
```

- **CLOSED:** checks go to Redis. Consecutive failures increment a counter.
- **OPEN:** Redis skipped, in-memory fallback used. After a timeout → HALF-OPEN.
- **HALF-OPEN:** a limited probe goes to Redis. Success → CLOSED; failure → OPEN.

Fail-open: if the store operation errors at any point, the request is served
(and rate limited in-memory) rather than blocked. Errors are logged at WARN.

---

## 7. Middleware / HTTP Contract

- Allowed: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Throttled: above + HTTP 429 + `Retry-After` + JSON body describing the state
- Fail-open: still sets headers based on in-memory fallback result

### Multi-rule header reporting (decided)

When several rules chain against one request, the `X-RateLimit-*` trio reports a
**single representative limit: the most restrictive applicable rule** — the one
with the lowest `remaining` (or the rule that denied). Headers are never
overwritten by loop order.

Rationale:
- Preserves the standard singular-header contract required by US-6 (one
  `Limit` / `Remaining` / `Reset`).
- Reporting the tightest budget minimizes client surprise: a request can still
  hit an *unreported* rule on a later call (e.g. a shared `global` budget
  exhausted by other clients), so headers are **advisory** — the 429 +
  `Retry-After` response is the authoritative signal.
- CSV / per-rule headers were considered and rejected as over-engineering at
  2–3 rules and a deviation from the US-6 header contract. Revisit only if the
  rule count grows beyond ~4.

---

## 8. Testing Strategy (BDD/TDD)

Tests are written first (red), implementation second (green), expressed as
given/when/then via Jest `describe`/`it`.

| Suite | Coverage |
|-------|----------|
| `sliding-window.test.ts` | within limit, at limit, reset, boundary, zero limit, single request |
| `store.test.ts` | memory (unit); Redis (integration, skips if unavailable) |
| `circuit-breaker.test.ts` | all state transitions |
| `middleware.test.ts` | 429, headers, allow, fail-open |
| `concurrency.test.ts` | 100 concurrent / limit 50 → exactly 50 allowed |

Redis integration tests skip gracefully when no local Redis is available.

---

## 9. Trade-offs

- **Header reporting model:** single most-restrictive `X-RateLimit-*` trio, not
  per-rule. Trade-off: hides the other rules' budgets, so headers are advisory;
  the 429 + `Retry-After` response is the authoritative signal. (See §7.)
- **Algorithm:** sliding window counter over token/leaking bucket — strict
  per-window enforcement rather than burst smoothing. (See §3.)

_Other decisions land here as they are made._

---

## 10. AI Usage

_To be filled in — how AI was used (planning, scaffolding, review), and how its
output was kept in check (avoiding slop, minimal unknown code)._

---

## 11. Roadmap (nice-to-haves, only if time permits)

- [ ] Prometheus-format `/metrics` endpoint (`prom-client`)
- [ ] Grafana dashboard on top of metrics
- [ ] Load / stress test script (10k requests, 100 concurrency)
- [ ] Structured JSON logging
