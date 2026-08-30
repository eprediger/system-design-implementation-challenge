# REVIEW — Battle-Test & Human Review Guide

A reusable adversarial-review artifact for the rate limiter. It serves two
audiences with the same contract: AI red-team agents (fresh-context, read-only)
and a human reviewer on a cold pass. The goal is to find what the tests cannot:
flaws the tests share with the code, spec-interpretation drift, race and timing
holes, and security-at-the-boundary issues.

## 0. Reviewer contract (mandatory)

- **Spec is truth, code is suspect.** The acceptance criteria in
  `specs/US-*.md` are authoritative. The implementation is guilty until proven
  to satisfy them. A finding is not "the code differs from the spec" per se; it
  is "the code fails a criterion" or "the criterion is unambiguously unmet".
- **Cite every finding:** `file:line` + a written reproduction of the reasoning.
  A finding without a location and a step-by-step fault path is noise.
- **Mark execution-dependent findings** as `[runtime-verify]` when they depend
  on timing, the wall clock, or a live process (e.g. race windows, TTL drift).
  Do not assert them as proven.
- **Classify severity:** `critical` (violates an acceptance criterion, data
  loss, security) · `major` (edge-case or race correctness) · `minor`
  (robustness, ergonomics) · `nit` (style, wording).
- **No praise.** A clean area is reported as "no findings in checked
  requirements", backed by the per-requirement checklist, never as a vibe.
- **Do not modify anything.** Review only; report findings. Fixes happen
  outside the review pass.

## 1. Scope

### In scope

- `src/domain/sliding-window.ts` — algorithm, rules, limiter
- `src/domain/rate-limit-result.ts` — value object + ruling comparison
- `src/domain/ports.ts` — `Store` / `Clock` / `IncrementResult` ports
- `src/adapter/redis.ts` — Lua-backed store, reconnect-on-demand
- `src/adapter/memory-store.ts` — in-memory fallback
- `src/adapter/circuit-breaker.ts` — state machine
- `src/adapter/fail-open-store.ts` — breaker + fallback wrapper
- `src/index.ts` — composition root (public API)
- `demo/src/server.ts` — reference HTTP consumer (trust proxy, headers, 429)
- Co-located tests + `demo/src/{server,stress,failover}.test.ts`
- Specs they must satisfy: `specs/US-1..8` acceptance criteria

### Out of scope (accepted deferrals — flag only if a reviewer disagrees on principle)

- `/metrics` and structured JSON logging (roadmap)
- The heavy-load benchmark (10k requests) — deferred; deterministic suites cover correctness
- Token-bucket algorithm — excluded by locked decision (§3/§9 in `DESIGN.md`)

### Reference documents

- `DESIGN.md` — intended behavior, trade-offs, §8 traceability matrix
- `README.md` / `AGENTS.md` — how to build & run
- `specs/US-*.md` — the authority for acceptance

## 2. How to run the gate under review

- Full gate: `npm run typecheck && npm run build && npm test` in
  `rate-limiter/` (or `docker run --rm --network host -v "$PWD:/app" -w /app/rate-limiter rate-limiter-dev ...`
  with compose Redis up), plus the demo gate in `demo/`.
- The tests, not the docs, are the co-authors of the code being reviewed —
  read them with suspicion equal to the code.

## 3. Review mandates

### M1 — Correctness core

Read `src/domain/sliding-window.ts`, `src/domain/rate-limit-result.ts`, and
their tests. Check:

- The weighted blend: `effectiveCount = previous * (1 - weight) + current`
  (sliding-window.ts:138-146). Is the weighting direction right at window
  start/end? Is `sectionWeight` correctly bounded `[0,1)`? What floats through
  when `windowMs` is huge/tiny, or `now` jumps (NTP step, clock skew)?
  **Both counters count *denied* attempts too** — verify a client can't erase
  its usage by overflowing into 429s.
- `Math.floor(now / windowMs)` rollover and the `reset = Math.ceil(windowEnd/1000)`
  (sliding-window.ts:101-105): seconds-vs-ms consistency, sub-second windows.
- `remaining = max(0, maxRequests - ceil(effectiveCount))` and
  `allowed = effectiveCount <= maxRequests` (sliding-window.ts:144-145):
  off-by-one at exactly `maxRequests`, and the conservative/liberal boundary
  at non-integer effective counts. **Ceil is deliberate** — a decaying fraction
  must not read as a whole free hit (see DESIGN §9).
- `isMoreRestrictiveThan` (rate-limit-result.ts:31-35): tie-break semantics vs
  the stated doc ("denial wins, lowest remaining wins; two denials → smaller
  limit wins; first rule keeps exact ties"). Is "denial beats allowed"
  consistent when an earlier denial and a later denial differ?
- `RateLimiterConfigurationError` on empty rules and constructor invariants
  (sliding-window.ts:83-91: `windowMs` finite positive, `maxRequests`
  non-negative integer). Zero `maxRequests` behavior.
- **Boundary reset vs US-1's wording:** the counter does *not* hard-reset at a
  boundary — US-1 is read implementation-neutrally ("the limit re-asserts as
  the window rolls"), and the boundary tests in sliding-window.test.ts pin the
  decay, not a reset. A literal hard reset would reintroduce the fixed-window
  boundary-burst flaw (§3 of DESIGN). Flag only if you dispute that reading.
- Test-cover equality: are the passing tests asserting the *right* numbers, or
  do any encode the same wrong assumption as the code (shared blind spot)?

### M2 — Distributed & atomicity

Read `src/adapter/redis.ts`, `demo/src/stress.test.ts`, `src/adapter/redis.test.ts`.
Check:

- The Lua script (redis.ts:7-13): is `INCR`+`PEXPIRE`+`GET` in `EVAL` atomic as
  claimed? Interleave scenarios between `INCR` and `GET` of the previous window.
- Key composition `rl:<base64url id>:<windowIndex>` (redis.ts:29-35): ids are
  encoded before embedding so `:`/glob characters can't collide or leak; `reset`
  (redis.ts:102-104) deletes id-exact via the same codec. Unicode/long keys vs
  the US-8 edge cases.
- TTL = `2 * windowMs` (redis.ts:90): does the previous window always survive
  long enough to be read? What about a window rolled over *twice* while a client
  is idle mid-window (the immediate-next-window write resets the TTL)?
- Reconnect-on-demand (redis.ts:79-87): the `status === 'end'` branch — the
  in-flight `connect()` is memoized, so two concurrent `run()` calls can't
  connect twice; connection string/URL handling.
- Atomic reset (RESET_SCRIPT, redis.ts:17-27, applied at 102-104): SCAN+DEL in
  one `EVAL` — atomicity of reset vs a concurrent increment; pipeline on an
  empty batch. **Scope: two-key `EVAL` is single-node/HA only — Redis Cluster
  would fail the increment script with CROSSSLOT (flag only if that matters).**
- stress.test.ts ceiling soundness (stress.test.ts:30-42): does `200 concurrent
  → exactly 100 allowed, remaining multiset [0..99]` actually prove a *global*
  ceiling across the two apps, or is there a path where both instances'
  requests could be double counted / dropped? Token uniqueness (`randomUUID`,
  stress.test.ts:19), and whether the counts could leak between the two
  `RedisStore`s.

### M3 — Fault tolerance & timing

Read `src/adapter/circuit-breaker.ts`, `src/adapter/fail-open-store.ts`,
`src/adapter/fail-open-store.test.ts`, `demo/src/failover.test.ts`.
Check:

- The state machine (circuit-breaker.ts:64-96): failure counter reset on
  success while CLOSED, half-open success accumulation, the `transitionToOpen`
  resetting both counters (lines 64-70). Concurrency of `exec()`: the
  single in-flight probe (lines 90-96) — two requests crossing the cooldown
  boundary simultaneously — how many probes reach the dependency? Is that a
  problem?
- `recoveryTimeoutMs < 0` guard (circuit-breaker.ts:57-58) — is `0` meaningfully
  "immediate probe"?
- Fail-open semantics (fail-open-store.ts:41-46): on a tripped circuit,
  `breaker.exec` throws `CircuitOpenError` and *every* short-circuited
  operation falls back **silently** — the WARN fires once per *real primary
  failure*, not per request, so an outage logs a few lines, not a storm
  (DESIGN §6). Is that the intended US-5 logging? Fail-open on `reset` could
  be surprising.
- The failover suite's relay: killing sockets mid-request — could a request
  hang rather than fail-fast (`.timeout` guards on every fetch)? The 600 ms
  sleep (failover.test.ts:142) vs `recoveryTimeoutMs: 500` is a wall-clock race
  the reviewer must assess.
- Both app instances share ONE breaker (failover.test.ts:78): is that
  global-vs-per-instance choice consistent with the degraded-per-instance
  guarantee the README promises?

### M4 — Security at the boundary

Read `demo/src/server.ts`, `demo/src/server.test.ts`. Check:

- `app.set('trust proxy', ...)` (server.ts:44): defaults to `'loopback'` —
  only loopback-originated requests may set `X-Forwarded-For`, so a
  directly-exposed instance cannot be spoofed. `TRUST_PROXY=true` opts into
  trusting all hops — is the README's caveat ("so per-IP rules work through a
  reverse proxy") adequate? Rate-limit-bypass via spoofing is the threat model
  here.
- `req.ip ?? 'unknown'` fallback (server.ts:35,81): what happens when IP is
  genuinely absent — all such clients collapse into one shared bucket
  (`unknown`)? Is that a leak (a shared DoS bucket) or correct-by-default
  (DESIGN §7: deliberate, no unbounded per-connection keys)?
- Path derivation `${req.ip ?? 'unknown'}:${method} ${normalizePath(req.path)}`
  (server.ts:35): path with a colon, path normalization (`/a//b` vs `/a/b`),
  query strings, verb splits. Bucket cardinality vs limit.
- Header/body rendering (server.ts:49-63): `retryAfter` always non-undefined on
  the 429 path? Header type coercion (numbers to strings), `Retry-After` unit
  (seconds, per US-6) — consistency with `reset` (unix seconds)?
- Unhandled middleware rejection: `await limiter.check(req)` throws if the
  store throws — Express 5 forwards async rejections, but is the 500 behavior
  after a breaker-less store failure acceptable, or should the demo compose a
  `FailOpenStore` on the default path too (currently opt-in via `REDIS_URL`,
  server.ts:14-16)?

### M5 — Independent requirement traceability

**Read the specs FIRST (`specs/US-*.md`), derive expected behavior for each
acceptance criterion on your own, and only then open the implementation.** Do
not let `DESIGN.md`'s §8 traceability matrix prime your answer — build the
mapping from first principles, then diff yours against it. Check:

- Each US-1..8 acceptance criterion: is it *actually* satisfied by shipped,
  running behavior (not by a documentation claim)? Reuse of the §0 severity
  schema for *gaps* is fine, but a gap is also just "spec says X, impl gives Y".
- Criteria marked `[runtime-verify]` in §8.1's matrix (e.g. US-4 p99, US-3
  10k): are the deferrals correctly scoped, and is any *deterministic* criterion
  hiding behind a "deferred" label?
- The matrix legend rows that are `◐` (partial) or `✦` (not applicable) — do you
  agree with the call, or is a deferral actually masking a real miss?

## 4. Report format

Return findings as a table or list. One entry per finding:

```
[severity] One-line title
  File: <path:line>
  What: <the fault path, step by step>
  Evidence: <the code/test/spec lines that show the fault>
  Verified: <static | [runtime-verify]: what to run to prove it>
  Suggested fix: <one sentence, if obvious>
```

End with a **per-requirement checklist** (US / criterion / status:
satisfies-or-finding-id) so a clean pass is auditable.

## 5. Sign-off (human reviewer)

Executed 2026-08-30 via a live opencode session: the machine-verifiable items
were run against the real stack (docker compose Redis + `demo` HTTP server);
the M1-M5 triage reflects the five-agent battle-test plus explicit author
decisions in the review session. Findings ledger is empty — every finding is
ticked `✔ fixed` or documented `◐ accepted trade-off` / `✖ rejected` throughout
this file and DESIGN §9.

- [x] Ran the full gate (lib + demo, with Redis) — recorded green
  - lib `rate-limiter/`: 7 suites / 67 tests; `tsc --noEmit` clean
  - demo `demo/`: 3 suites / 7 tests (incl. `stress`, `failover` against live
    Redis via `--network host`)
- [x] Stepped a real request through `curl` with `X-Forwarded-For` — headers match US-6
  - 10 hits → 200 with `X-RateLimit-Limit: 10`, `Remaining` 9→0, consistent
    `Reset` (unix seconds); 11th → 429 + `Retry-After` (seconds) + JSON body;
    fresh XFF client and no-XFF client each got their own bucket (isolation).
- [x] Killed Redis mid-flight (`demo` with `REDIS_URL`) — requests keep flowing, WARNs seen
  - `docker compose stop redis` → 5/5 requests still 200 (memory fallback);
    exactly 3 WARN lines (one per real failure as the breaker tripped), then
    silence — no per-request storm. `docker compose start redis` → after the
    cooldown a fresh client's counters land in Redis again (circuit re-seated);
    outage counts discarded (documented §6 discontinuity).
- [x] Worked the M1-M5 checklists; triaged each finding to *accepted-verified* /
      *accepted-deferred* / *rejected-with-reason*
  - Full triage map per mandate in the session; headline calls: M1 boundary
    decay kept (US-1 read implementation-neutrally), M4 trust-proxy default +
    `'unknown'` shared bucket both deliberate, M2 single-node Redis scope
    recorded, token-bucket / metrics / load deferred (§ 8.1, § 11).
- [x] Accepted findings fixed and re-gated; §8/§9/§10 in `DESIGN.md` reflect the outcome
- [x] This file's findings ledger is empty (all triaged)