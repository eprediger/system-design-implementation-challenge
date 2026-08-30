# DESIGN — Server-Side API Rate Limiter

> **Status: WIP.** This document is a living record, updated as decisions are made
> during implementation. It is not a post-hoc write-up.

## TL;DR

- **Language/stack:** TypeScript on Node.js, ioredis, Jest
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
- **Schema-validation library** — TS types cover config
- **(Roadmap)** Prometheus-format `/metrics` endpoint; Grafana dashboard

---

## 2. Architecture

```
Hit → Consumer middleware → SlidingWindowLimiter.check(hit) → Response
                                        │
                     per rule: bucketOf(item) → bucket counter
                                        │
                                  CircuitBreaker
                                  Redis ⇄ in-memory fallback
```

### Component map

| Component         | File                          | Responsibility                                              |
| ----------------- | ----------------------------- | ----------------------------------------------------------- |
| Rules             | consumer-declared `BucketRule[]` | `bucketOf(item)` + `RateLimitRule` per counter bucket       |
| Rate limiter core | `domain/sliding-window.ts`    | Algorithm + domain types + `BucketRule` / `SlidingWindowLimiterOptions`     |
| Rate limit result | `domain/rate-limit-result.ts` | `RateLimitResult` value object + most-restrictive ruling comparison |
| Domain ports      | `domain/ports.ts`             | Driven ports (`Store`, `Clock`, `IncrementResult`) — domain owns them    |
| Memory store      | `adapter/memory-store.ts`     | In-process fallback (Map + expiry), implements `Store` port |
| Redis store       | `adapter/redis.ts`            | Atomic Lua scripts, shared state, implements `Store` port   |
| Circuit breaker   | `adapter/circuit-breaker.ts`  | Closed/Open/Half-open state machine                         |

HTTP handling (deriving `bucketOf` from the request, `trust proxy`, headers,
429 rendering) lives in the reference consumer `demo/`, outside the library.

---

## 3. Algorithm: Sliding Window Counter

### Decision

We evaluated **five** candidate algorithms against the concrete requirements,
and chose **sliding window counter**. All state is O(1) per key; requests are
answered with an immediate allow/deny; and the "exactly N allowed per window"
acceptance criteria (US-1, US-8) hold.

| Algorithm                  | Precision | Memory           | Allow/deny        | Distributed (Redis)        | Verdict                                                      |
| -------------------------- | --------- | ---------------- | ----------------- | -------------------------- | ------------------------------------------------------------ |
| Fixed Window Counter       | Low       | O(1)             | Immediate         | Simple single counter      | **Rejected** — boundary burst                                |
| Sliding Window Log         | High      | **O(n)/key**     | Immediate         | Sorted set, O(n) per key   | **Rejected** — violates O(1) memory                          |
| Token Bucket               | Medium    | O(1)             | Immediate         | Needs atomic refill state  | **Rejected** — allows bursts, conflicts with strict window   |
| Leaking Bucket             | High      | **O(burst)/key** | **Delays/queues** | Complex queue state        | **Rejected** — queues instead of denying; breaks low latency |
| **Sliding Window Counter** | **High**  | **O(1)**         | **Immediate**     | **Atomic two-counter Lua** | **Chosen**                                                   |

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

- **Redis:** one atomic Lua script (`INCR` the current-window counter, `GET` the
  previous one, `PEXPIRE` in a single `EVAL`) — no race conditions between the
  read-modify steps and no lost counts under concurrent requests across
  processes, in one round trip. Keys are `rl:<identity>:<windowIndex>`, TTL is a
  fixed `2 * windowMs` (current window's remainder + the following window, during
  which it is read as the weighted "previous"). A regression test pins the TTL to
  exactly that bounded window (it must never scale with the epoch `windowIndex`).
- **Memory:** two counters per key plus a cheap lazy expiry sweep.

---

## 4. Rules

Rules are declared by the consumer as `BucketRule[]`: each pairs a
`RateLimitRule` (the budget) with a `bucketOf(item)` closure that maps the
checked item to its counter bucket. The library declares the signature but
never decides what a bucket means (IP, endpoint, tenant, ...), so it stays
blind to its client's domain.

```ts
const rules: Array<BucketRule<Request>> = [
  { bucketOf: () => 'global',           rule: { windowMs: 60_000, maxRequests: 1000 } },
  { bucketOf: h => h.ip,                rule: { windowMs: 60_000, maxRequests: 100 } },
  { bucketOf: h => `${h.ip}:${h.path}`, rule: { windowMs: 60_000, maxRequests: 10 } },
];
```

### Why bucket derivation rides on the rule

The candidate alternative was a descriptor/extractor system — rules as pure
config data (`{ key: 'ip', ... }`) resolved by the library, the pattern in the
Lyft example. Rejected: a descriptor references a bucket through a separate
resolver registry, and a rule whose descriptor has no resolver is an undefined
function call mid-request. A closure co-located on the rule makes that
impossible structurally: a rule cannot exist without its `bucketOf`.

Trade-off accepted: rules are code, not serializable config. If a consumer
wants file-driven rules later, the binder maps descriptor → `bucketOf` at load
and fails loudly on unknown descriptors — a startup error, never undefined
behavior at request time.

### Error handling

- **Configuration invariants** — a limiter built with zero rules throws a typed
  `RateLimiterConfigurationError` from its constructor (used via `instanceof`
  at the composition root). Startup misconfiguration fails fast and loud,
  never as a silently permissive limiter.
- **Budget violations** — are *results*, not exceptions: `RateLimitResult`
  carries `allowed: false`, `remaining`, and `retryAfter`. The rate limit is
  exercised per hit, so the hot path stays exception-free.
- **Infrastructure failures** (store down in `check`) — propagate as exceptions
  and are absorbed by the circuit breaker's fail-open policy; consumers never
  catch per-request store errors in normal operation.

---

## 5. Store Interface

```ts
interface IncrementResult {
  current: number;   // count in the window `windowIndex`
  previous: number;  // count in `windowIndex - 1`, for the weighted blend
}

interface Store {
  increment(key: string, windowMs: number, windowIndex: number): Promise<IncrementResult>;
  get(key: string, windowMs: number, windowIndex: number): Promise<number>;
  reset(key: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
```

`windowIndex = floor(now / windowMs)`; `increment` reports both the current
and previous window counts in a single atomic operation (no race conditions,
one round trip). Two implementations: Redis (atomic, shared) and in-memory
(fallback). The interface is deliberately small — only what the sliding-window
algorithm needs. The spec lists `set(key, value, ttl)` as a method; we cut it
because sliding window never needs unconditional sets.

---

## 6. Circuit Breaker

```
CLOSED (healthy) --N failures--> OPEN (fallback) --timeout--> HALF_OPEN (test) --M successes--> CLOSED
      ^                                                                                 │
      └──────────────────────────── failure reopens → ─────────────────────────────────┘
```

- **CLOSED:** checks go to Redis. Consecutive failures increment a counter.
- **OPEN:** Redis skipped, in-memory fallback used. After a timeout → HALF_OPEN.
- **HALF_OPEN:** a limited probe goes to Redis. Success → CLOSED; failure → OPEN.

Fail-open: if the store operation errors at any point, the request is served
(and rate limited in-memory) rather than blocked. Errors are logged at WARN.

---

## 7. Middleware / HTTP Contract

Bucket derivation and the most-restrictive aggregation are implemented in
`SlidingWindowLimiter.check`: each configured rule maps the item to its bucket
via `bucketOf`, counts it, and the verdicts are folded into one ruling (a
denial beats an allowed tie; otherwise the lowest `remaining` wins; the first
rule wins an exact tie). The comparison lives on the `RateLimitResult` value
object (`isMoreRestrictiveThan`), so the limiter orchestrates without reaching
into result fields. Consumers only render HTTP — they hand the check the item
and translate the ruling result.

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
given/when/then via Jest `describe`/`it`. Each test file is co-located beside
its subject (`*.test.ts` next to the module it tests).

| Suite                       | Location                              | Coverage                                                            |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| sliding-window              | `src/domain/sliding-window.test.ts`   | within limit, at limit, reset, boundary, zero limit, single rule, multi-rule aggregation (most restrictive, denial-wins-tie, first-on-tie), empty-rules construction throw |
| memory store                | `src/adapter/memory-store.test.ts`    | unit                                                                 |
| redis store                 | `src/adapter/redis.test.ts`           | integration, skips if unavailable                                    |
| circuit-breaker             | `src/adapter/circuit-breaker.test.ts` | all state transitions                                               |
| concurrency                 | `src/domain/concurrency.test.ts`      | 100 concurrent / limit 50 → exactly 50 allowed                      |

Redis integration tests skip gracefully when no local Redis is available.

---

## 9. Trade-offs

- **Header reporting model:** single most-restrictive `X-RateLimit-*` trio, not
  per-rule. Trade-off: hides the other rules' budgets, so headers are advisory;
  the 429 + `Retry-After` response is the authoritative signal. (See §7.)
- **Algorithm:** sliding window counter over token/leaking bucket — strict
  per-window enforcement rather than burst smoothing. (See §3.)
- **Redis atomicity:** the shared-counter increment must be one Lua `EVAL`
  (INCR + GET + PEXPIRE) rather than separate commands — interleaving between
  processes would let a count land in the window after it was read as
  "previous," losing it. Cost: a small inline Lua string in the adapter;
  benefit: correctness under the distributed (US-3) and concurrency (US-8)
  criteria. Counter keys self-expire after `2 * windowMs`.

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
