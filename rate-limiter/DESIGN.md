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
- **Observability mechanisms** — the library ships an optional `Emitter` event
  port (`domain/events.ts`) and no logging/metrics of its own; consumers attach
  their own mechanisms. The reference demo attaches pino + prom-client (wide
  events, §8).
- **(Roadmap)** Grafana dashboard on top of the demo metrics
- **Observability mechanisms** — the library ships an optional `Emitter` event
  port (`domain/events.ts`) and no logging/metrics of its own; consumers attach
  their own mechanisms. The reference demo attaches pino + prom-client (wide
  events, §8).

---

## 2. Architecture

```
Hit → Consumer middleware → SlidingWindowLimiter.check(hit) → Response
                                        │
                     per rule: bucketOf(item) → bucket counter
                                        │
```

### Component map

| Component         | File                             | Responsibility                                                          |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------- |
| Rules             | consumer-declared `BucketRule[]` | `bucketOf(item)` + `RateLimitRule` per counter bucket                   |
| Rate limiter core | `domain/sliding-window.ts`       | Algorithm + domain types + `BucketRule` / `SlidingWindowLimiterOptions` |
| Rate limit result | `domain/rate-limit-result.ts`    | `RateLimitResult` value object + most-restrictive ruling comparison     |
| Domain ports      | `domain/ports.ts`                | Driven ports (`Store`, `Clock`, `IncrementResult`) — domain owns them   |
| Memory store      | `adapter/memory-store.ts`        | In-process fallback (Map + expiry), implements `Store` port             |
| Redis store       | `adapter/redis.ts`               | Atomic Lua scripts, shared state, implements `Store` port               |
| Observability port| `domain/events.ts`               | `Emitter` shape + `LimiterEvent` union: `check`, `storeFallback`      |

HTTP handling (deriving `bucketOf` from the request, `trust proxy`, headers,
429 rendering) lives in the reference consumer `demo/`, outside the library.

### Observability: library port, consumer mechanisms

The library stays dependency-light (ioredis only) and opinion-less about
logging/metrics. It exposes one optional **`Emitter`** sink (`domain/events.ts`)
that reports what it did:

| Event            | On                                              | Carries                                   |
| ---------------- | ----------------------------------------------- | ----------------------------------------- |
| `check`          | every rate-limit check                          | ruling bucket, rule index, allowed, limit, remaining, reset, retryAfter |
| `storeFallback`  | every fallback serve (Redis down / circuit open)| bucket key, fallback kind, reason, lastError on a real primary failure |

Consumers inject the **same** `Emitter` into the limiter, circuit breaker, and
`FailOpenStore` and attach their own mechanisms; the demo attaches
[pino](https://getpino.io) + [prom-client](https://prometheus.io/docs/guides/nodejs/).

The demo's style is **wide events** (one context-rich log line per request,
written once as the response finishes, per the *loggingsucks.com* distillation):
a throttled request logs once at `warn` with bucket/rule/retryAfter/IP/requestId
carried as fields, an unhandled error logs once at `error` with the stack, and
everything else logs once at `info`. Per-serve `storeFallback` events fold into
the request's wide event (`store: { served_from, reason, error? }`) plus a
counter instead of a log line, so an outage flags on the wide event without a
storm. Breaker open/close are lifecycle events and stay separate lines. Heavy
tails stay deferred: sampling debug context per request is downstream homework.

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
  processes, in one round trip. Keys are `rl:<encoded id>:<windowIndex>`, TTL is a
  fixed `2 * windowMs` (current window's remainder + the following window, during
  which it is read as the weighted "previous"). A regression test pins the TTL to
  exactly that bounded window (it must never scale with the epoch `windowIndex`).
- **Key encoding:** bucket ids are base64url-encoded before being embedded in a
  key, so id characters that would collide in the key shape (`:`, glob chars) or
  leak across identities cannot. `reset` is therefore exact — it deletes only the
  one identity, never a twin. Both stores share the codec (`adapter/bucket-id.ts`).
- **Atomic reset:** Redis `reset` is its own `EVAL` (SCAN + DEL inside the
  script), so a concurrent increment can never interleave with the deletion half
  way through. Memory reset is a single-threaded map sweep (prefix-exact).
- **Command timeouts:** `RedisStore` fails a command that gets no reply in 2s
  (`commandTimeout`), so even a connection that silently half-opens (drops
  packets without closing) surfaces to the fail-open wrapper instead of hanging
  a request forever.
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
      └──────────────────────────── failure reopens → ──────────────────────────────────┘
```

- **CLOSED:** checks go to Redis. Consecutive failures increment a counter.
- **OPEN:** Redis skipped, in-memory fallback used. After a timeout → HALF_OPEN.
- **HALF_OPEN:** one in-flight probe goes to Redis (concurrent calls short-circuit
  to the fallback instead of piling on). Success → CLOSED; failure → OPEN.

Wired as `FailOpenStore` (`adapter/fail-open-store.ts`): a `Store` composing the
primary (Redis), the breaker, and an in-memory fallback. Every operation runs
through the breaker; on any failure — a tripped circuit or a throwing primary —
it serves from the fallback, so requests are rate limited (from memory) rather
than blocked. A **real primary failure logs one WARN** at the moment it is
surfaced; requests short-circuited while the circuit is already OPEN fall back
**silently** (`CircuitOpenError` is the sentinel), so an outage cannot turn into
a per-request log storm. Recovery is automatic: the half-open probe decides
whether to close the circuit and re-use Redis. `RedisStore` fails fast (bounded
reconnect ending the client after a few attempts, `connectTimeout` + 2s
`commandTimeout`) so a down or half-open Redis surfaces to the wrapper quickly
instead of hanging commands behind an endless retry queue — and reconnects on
demand for the next operation once Redis is back, so the half-open probe can
genuinely re-seat it. Counts stored in the memory fallback during an outage are
discarded on re-seat (the shared Redis resumes from its own, older counters) —
a deliberate enforcement discontinuity, fail-open is about *availability*, not
state continuity.

US-5's "logged, and metrics are updated" acceptance criterion is fully met:
real primary failures WARN once (per request via the built-in `warn` hook, or
per event via the demo's emitter), and the demo counters every fallback
(`rate_limit_fallback_total{reason=...}`) without turning an outage into a per-request log storm.

---

## 7. Middleware / HTTP Contract

Bucket derivation and the most-restrictive aggregation are implemented in
`SlidingWindowLimiter.check`: each configured rule maps the item to its bucket
via `bucketOf`, counts it, and the verdicts are folded into one ruling (a
denial beats an allowed tie; otherwise the lowest `remaining` wins; when two
rules both deny, `remaining` is 0 for both so the **smallest limit** wins —
the tightest budget; an exact tie keeps the first rule). The comparison lives
on the `RateLimitResult` value object (`isMoreRestrictiveThan`), so the
limiter orchestrates without reaching into result fields. Consumers only
render HTTP — they hand the check the item and translate the ruling result.

- Allowed: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Throttled: above + HTTP 429 + `Retry-After` + JSON body describing the state
- Fail-open: still sets headers based on in-memory fallback result

### Reference consumer security posture (demo)

- `trust proxy` defaults to `'loopback'`: only requests arriving from a
  loopback address may set `X-Forwarded-For`, so a remote client cannot spoof
  its way out of per-IP limits. Deployments behind a genuine forward proxy set
  `TRUST_PROXY=true` to trust all hops — a config they must own, not a default.
  `X-Powered-By` is disabled.
- Endpoint buckets canonicalize the path (`percent-decode` + run-on `/`
  collapse) and include the HTTP method, so spelling variants of the same
  endpoint share one counter and different verbs get different budgets.
  Canonicalization lives with the consumer, mirroring `bucketOf` ownership (§4);
  the library itself stays path-agnostic.
- No-IP clients all map to the `'unknown'` bucket (`req.ip ?? 'unknown'`).
  Deliberate: a client that offers no address still gets *a* budget — but it is
  one shared bucket, so anonymous traffic competes for one limit. Correct by
  default (no unbounded per-connection keys); a consumer that cares identifies
  such requests another way and composes its own `bucketOf`.

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

| Suite           | Location                              | Coverage                                                                                                                                                                   |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sliding-window  | `src/domain/sliding-window.test.ts`   | within limit, at limit, reset, boundary decay semantics, zero limit, single rule, multi-rule aggregation (most restrictive, denial-wins-tie, smallest-denied-budget, tie), radial config validation |
| rate-limit-result | `src/domain/rate-limit-result.test.ts` | the "most restrictive wins" ruling comparison in isolation (deny beats allow, lowest remaining, smallest denied limit, tie) |
| memory store    | `src/adapter/memory-store.test.ts`    | unit                                                                                                                                                                       |
| redis store     | `src/adapter/redis.test.ts`           | integration, skips if unavailable; reconnect-on-demand after a lost connection (in-test TCP relay), concurrent reconnect, 100 concurrent increments, exact reset with delimiter/glob ids, `commandTimeout` on a silent socket |
| concurrency     | `src/domain/concurrency.test.ts`      | 100 concurrent / limit 50 → exactly 50 allowed                                                                                                                             |
| fail-open store | `src/adapter/fail-open-store.test.ts` | fallback + WARN on primary failure, OPEN skips the primary, half-open recovery re-uses it, `storeFallback` per serve with reason |
| event sink      | `src/domain/sliding-window.test.ts` (event describe block) | ruling `check` event carries bucket/ruleIndex/limit/remaining/reset/retryAfter |
| demo logging    | `demo/src/logger.test.ts`            | level filtering, valid JSON, timestamp + service + context fields                                                         |
| demo metrics    | `demo/src/metrics.test.ts`           | counters, allowed/throttled split, p50/p95/p99 histograms (check + store ops), reset, timed-store decorator, 100-request snapshot |
| demo wide events| `demo/src/wide-event.test.ts`       | throttled → one `warn` wide event with bucket/rule/retryAfter/IP/requestId; store failure → `error` wide event with stack; fallback flagged without log storm (wide line + counters + breaker line only) |
| distributed stress | `demo/src/stress.test.ts`          | skips without Redis: two server instances sharing one Redis → 200 concurrent requests, exactly 100 allowed globally                                                         |
| failover        | `demo/src/failover.test.ts`           | skips without Redis: TCP relay in front of Redis, mid-load outage → still served from fallback (+ rate-limit headers asserted), recovery → circuit re-seats on Redis      |

Redis integration tests skip gracefully when no local Redis is available. The
demo stress/failover suites skip too. Heavy load benchmarking (per US-8, "load
tests run separately") is deferred — the deterministic concurrency,
distributed-sharing, and failover acceptance criteria are covered in CI instead.

### 8.1 Requirement Traceability

Each spec's acceptance criteria against the artifacts that satisfy them.
Legend: **✔** covered by an automated test in the CI gate · **◐** partially
(the uncovered part is called out) · **▶** deferred — pointer to where ·
**✦** not applicable — excluded by a locked-in decision.

| US | Acceptance criterion | Satisfied by | Status |
| --- | -------------------- | ------------ | ------ |
| US-1 | allowed client gets `X-RateLimit-*` headers | `sliding-window.test.ts` within-limit; `demo/src/server.test.ts` most-restrictive headers | ✔ |
| US-1 | over-limit client gets 429 + `Retry-After` | `sliding-window.test.ts` at-limit/over; `server.test.ts` throttling | ✔ |
| US-1 | window reset re-allows the client | `sliding-window.test.ts` boundary: the previous window decays, not a hard reset (the boundary still counts it at full weight; capacity frees as it expires) | ✔ |
| US-2 | same key shares a counter; different keys don't | `sliding-window.test.ts` identity isolation; `server.test.ts` distinct clients; exact `reset` under delimiter/glob ids (`redis.test.ts`) | ✔ |
| US-2 | custom key extractor used | `BucketRule.bucketOf` *is* the extractor — `perIp`/`perIpEndpoint` in `server.test.ts` (no extractor registry; §4) | ✔ |
| US-2 | multiple rules all evaluated | `sliding-window.test.ts` multi-rule aggregation; `server.test.ts` most-restrictive | ✔ |
| US-3 | two instances + Redis → global ceiling | `demo/src/stress.test.ts` (exactly 100 of 200 across two apps) | ✔ |
| US-3 | atomic ops, no races | `redis.ts` single Lua `INCR+GET+PEXPIRE`; `redis.test.ts` current/previous + 100 concurrent increments; `reset` is atomic Lua too (SCAN+DEL in one `EVAL`) | ✔ |
| US-3 | 10,000+ concurrent enforced accurately | stress suite at 200 concurrent | ▶ heavy load deferred (§ 8 intro, § 11) |
| US-4 | p99 < 5 ms (memory) / < 20 ms (Redis) | — | ▶ no load harness, deferred (§ 11) |
| US-4 | Redis down/slow → request not blocked | `fail-open-store.test.ts`; `redis.test.ts` unreachable port + silent-socket `commandTimeout`; `demo/src/failover.test.ts` | ✔ |
| US-4 | O(1) time and memory per key | by construction (§ 3: counter, one `EVAL`) — not a timed proof | ✔ |
| US-4 | connection pooling | one persistent ioredis connection per store, no per-request churn (intent met; no min/max sizing) | ✔ |
| US-5 | unreachable Redis → in-memory fallback | `fail-open-store.test.ts`; failover phase B | ✔ |
| US-5 | N consecutive failures → OPEN, skip Redis | failover phase B asserts `OPEN` | ✔ |
| US-5 | recovery → closed, Redis re-used | failover phase C; `redis.test.ts` reconnect-on-demand | ✔ |
| US-5 | failure logged **and metrics updated** | WARN via the `warn()` hook + demo emitter; `rate_limit_fallback_total` asserted in `demo/src/wide-event.test.ts` | ✔ |
| US-6 | throttled → 429 | `server.test.ts` | ✔ |
| US-6 | `Retry-After` + `X-RateLimit-*` on 429, and on allowed | `server.test.ts` (headers asserted on both paths) | ✔ |
| US-6 | throttled → JSON error body | `server.test.ts` `toMatchObject` | ✔ |
| US-6 | fail-open still sets headers | § 7 behavior; failover phase B asserts the `X-RateLimit-*` trio on the fallback path | ✔ |
| US-7 | metrics counters + latency histograms | `demo/src/metrics.test.ts` (counters, allowed/throttled, p50/p95/p99 `check_ms` + `store_op_ms`, 100-request snapshot, /metrics route) | ✔ |
| US-7 | structured logs (throttled, fallback, errors) | `demo/src/wide-event.test.ts` throttled warn event; store-failure error event with stack; fallback folded into wide event without a log storm | ✔ |
| US-8 | 100 concurrent / limit 50 → exactly 50 allowed | `src/domain/concurrency.test.ts` | ✔ |
| US-8 | window-boundary counts accurate | `sliding-window.test.ts` boundary/transition | ✔ |
| US-8 | token bucket burst consumed correctly | — | ✦ token bucket not implemented (locked decision, § 3/§ 9) |
| US-8 | edge cases: zero limit, single request, reset timing | `sliding-window.test.ts` | ✔ |
| US-8 | 10k/100-concurrency load config | stress suite (200 concurrent) | ▶ heavy load deferred (§ 11) |

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
  criteria. Counter keys self-expire after `2 * windowMs`. `reset` is atomic
  the same way (SCAN + DEL inside one `EVAL`) so deletion can't interleave with
  an increment; it is deliberately O(n)-ish over live keys, which is fine
  because resets are rare. **Scope note: the two-key `EVAL` is not hash-tag
  collocated, so on a Redis *Cluster* topology the script would fail with
  `CROSSSLOT`. The supported deployment is single-node / HA replica, not
  cluster; a `ponytail:` comment marks this at the script site.
- **Boundary semantics vs US-1's "window reset":** a sliding-window *counter*
  does **not** hard-reset at a boundary — at the exact window turn the previous
  window still counts at full weight, and capacity frees only as that window
  decays. A burst right after midnight is therefore not instantly re-admitted.
  Both counters (current *and* previous) count **every** attempt, denied ones
  included — otherwise a client could erase its quota by overflowing into 429s.
  US-1's "window reset re-allows" is read implementation-neutrally: the limit
  *re-asserts* as the window rolls, which this decay does accurately. A literal
  hard reset is what would be wrong — it lets a client get up to 2× its limit
  inside a 60s span centered on the boundary (the exact fixed-window burst flaw
  §3 rejected). The defining trade-off (chosen in §3) is pinned in the
  boundary tests, not papered over.
- **`remaining` is ceiled:** an effective usage of e.g. 2.6 reports 0 remaining
  (3 − ⌈2.6⌉), never 1 — a decaying fraction must not read as a whole free hit.
  `Retry-After` points at the end of the current fixed window and is
  *advisory*: the sliding blend is what actually re-admits, slightly before or
  after that instant, so clients should treat it as an approximate back-off.
- **Clock assumption:** window math runs on one wall clock (`Date.now`, shared
  across processes via the epoch-derived `windowIndex`). The system assumes the
  clock doesn't jump backwards mid-window (that would re-open an old window) and
  that processes share a clock; a monotonic per-process clock would break the
  shared Redis counter. Distributed clock skew is bounded by `windowMs` and
  self-heals (TTL + fresh epoch windows), so it skews the *blend* slightly
  rather than the allowance.

_Other decisions land here as they are made._

---

## 10. AI Usage

The implementation (code, tests, docs) was produced in an
AI-assisted session (opencode on a local CLI) with the human author keeping
control at each step. This section states how AI was used and how its output was
kept honest.

**What AI did**

- Translated the US-1..8 specs into a build sequence (one step per US), proposed
  the increment plan and file layout, and negotiated scope lock-ins with the
  author before writing code (e.g. sliding-window counter over token bucket,
  `BucketRule`+`bucketOf` over an extractor registry, observability as a
  consumer-attached `Emitter` port — not a `/metrics` endpoint hard-wired into
  the library — plus deferring the heavy-load work).
- Scaffolded the solution and wrote the bulk of the code and co-located
  BDD-style tests, red-first on paper (cases derived from each spec's test
  plan) then green with the implementation.
- Ran the full gate (`typecheck` + `build` + `jest` incl. Redis integration)
  inside Docker before every commit; reused native tooling (Docker, Compose,
  jest, ts-jest) instead of inventing a stack.
- Debugged live failures: a stale packed tarball shipping an older buggy
  `redis.ts` (substitution/integrity fault), and a real gap — ioredis's bounded
  `retryStrategy` ending the client permanently, so recovery could open again
  but never re-use Redis. The fix (`reconnect on demand`) is a genuine product
  fix found through testing, not a code review artifact.
- Maintained `DESIGN.md`, `README.md`, and `AGENTS.md` in the same increment as
  the code (per the project's docs-sync policy).

**How output was kept in check**

- **Ponytail mode** throughout: shortest working solution, stdlib before
  dependencies (the fault-injection relay is `node:net`, no test dependency),
  deletion over addition, and deliberate simplifications flagged with
  `ponytail:` comments instead of silently shipped.
- **Signed-off increments:** no commit without the author's explicit go-ahead;
  every step was reviewed by the author before the next one started, and the
  author rewrote/renamed commits they wanted shaped differently.
- **Locked-in decisions protected** (see AGENTS.md): the assistant proposes,
  the author decides — e.g. US-8's token-bucket acceptance criterion is
  explicitly ✦ not applicable because the author locked the algorithm choice.
- **Verification before commit:** the full test gate (unit, integration,
  concurrency, demo stress/failover, skip paths) was executed with and without
  Redis before each commit; docs updated in the same pass so they describe the
  shipped code, not an ideal.
- **Adversarial review (battle-test):** after feature work, the assistant
  spawned five fresh-context review agents (correctness/distributed
  atomicity/fault-tolerance/security/spec-traceability), each asked to find
  only faults against the committed checklist in `REVIEW.md`. Confirmed
  findings were fixed in a dedicated pass (see `git log`), the rest recorded
  as accepted trade-offs. The human review pass against the same `REVIEW.md`
  §5 checklist has since been completed (2026-08-30): gate re-run, live
  `curl` with `X-Forwarded-For`, and killed-Redis-mid-flight all verified
  against the real stack, and the M1-M5 findings were triaged with the author
  session by session.

**Cost of assistance** The project leans on the assistant for breadth (edge
cases, test phrasing). The author reviewed and validated the reasoning at a
high level but did not hand-verify every line; the de-risking gap was closed
by the battle-test fixes plus the REVIEW.md §5 sign-off recorded above.

---

## 11. Roadmap (nice-to-haves, only if time permits)

- [ ] Grafana dashboard on top of the demo's `/metrics`
- [ ] Load / stress test script (10k requests, 100 concurrency)
- [ ] Structured logging pipeline (ELK/OTel ingestion, alerting) feed from the
      demo's wide events
- [ ] Sampling so debug-level request context lands on a subsample of wide
      events instead of all log lines
