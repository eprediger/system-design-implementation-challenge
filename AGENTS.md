# AGENTS.md

## Project

Server-side API rate limiter (TypeScript). Solution lives in `rate-limiter/`; specs are in `rate-limiter/specs/US-*.md`. Entry point / public API is `src/index.ts`. Human-facing run docs: root `README.md`.

## Commands (run from `rate-limiter/`)

There is no local Node here — things run via Docker (`node:24-slim` dev image). Redis runs via Docker Compose from the repo root:

```
docker compose up -d redis    # start Redis (integration tests)
docker compose exec redis redis-cli ping
docker compose down -v        # stop and drop the volume
```

- `docker build -t rate-limiter-dev .` — build the image (deps installed via `npm ci`).
- `docker run -it --rm rate-limiter-dev bash` — interactive shell; run commands by hand inside: `npm run typecheck`, `npm run build`, `npm test`, `npx jest <file>.test.ts` (single suite).
- One-shot: `docker run --rm rate-limiter-dev npm test`. With Redis up, the integration suite needs the host network so the container's `127.0.0.1:6379` reaches the compose service (plain run silently skips it): `docker run --rm --network host -v "$PWD:/app" -w /app rate-limiter-dev npm test`.
- The demo's `npm test` (from `demo/`) similarly runs its Redis-gated suites (`stress`, `failover`) when Redis is reachable and skips them otherwise — use `--network host` to run them locally.
- `REDIS_URL` (default `redis://127.0.0.1:6379`) points the suite at a different instance; CI provides Redis as a job service, so no flag is needed there.

Same scripts work on native Node >= 18: `npm run typecheck` (`tsc --noEmit`; there is no lint script), `npm run build` (`tsc` → `dist/`), `npm test` (`jest --runInBand`). `npm start` serves the lib entry only — HTTP comes with the reference demo (`demo/`).

## Workflow & style

- BDD/TDD: tests written first (red), implementation second (green), given/when/then in `describe`/`it`. Spec acceptance criteria map directly to test cases.
- Docs are kept in sync with the code increment-by-increment: any change to the public API or architecture updates `DESIGN.md` / root `README.md` / this file in the same pass. No end-of-work documentation batch.
- Tests are co-located: `*.test.ts` sits beside the module it tests under `src/` (jest `roots` = `src/`); the build excludes test files.
- Architecture policy (target): Hexagonal Architecture + DDD — domain core isolated from infrastructure, ports & adapters, framework-agnostic HTTP middleware. Current code does not fully conform yet; convergence is a deferred refactor, a separate task from feature work (don't restructure mid-feature).
- Strict TS, CommonJS. Keep code minimal; mark deliberate corner-cuts with a `ponytail:` comment.

## Structure

- `src/domain/sliding-window.ts` — algorithm (`SlidingWindowLimiter`) + the rule vocabulary (`RateLimitRule`, `BucketRule<T>`, `SlidingWindowLimiterOptions`) + `RateLimiterConfigurationError`.
- `src/domain/rate-limit-result.ts` — the `RateLimitResult` value object and its ruling comparison (`isMoreRestrictiveThan`).
- `src/domain/ports.ts` — driven ports (`Store`, `IncrementResult`). Domain owns its ports; adapters import them.
- `src/adapter/` — `memory-store.ts` (in-memory `Store` impl), `fail-open-store.ts` (`Store` that holds the circuit state and serves from memory with a WARN when the primary is down or the circuit is open).
- `src/domain/events.ts` — observability port (`Emitter` + `LimiterEvent` union: `check`, `storeFallback`). The library only emits; logging/metrics mechanisms live with the consumer.
- `src/index.ts` — composition root re-exporting the public API.
- `REVIEW.md` — committed review checklist (adversarial mandates + human-review sign-off). After feature increments, run a fresh-context red-team against it and fix confirmed findings in a dedicated pass; do-not-edit while reviewing.
- `demo/` (outside the lib) — reference HTTP consumer: consumes the packed `rate-limiter` tarball by package name; `createApp(rules, storeFactory?, logger?)` builds the limiter, middleware calls `check(req)` and renders headers/429; pino + prom-client observability (`logger.ts`, `metrics.ts`, `wide-event.ts` — one wide log line per request, `/metrics` route, `LOG_LEVEL` filter); `stress.test.ts` (two instances sharing one Redis → global ceiling) and `failover.test.ts` (in-test TCP relay in front of Redis → outage keeps serving, recovery re-seats) are Redis-gated suites.

## Locked-in decisions (do not reinvent)

- Express, ioredis, Jest. Sliding-window counter (O(1) time/space), NOT sliding-window-log (O(n)).
- `Store` interface with two impls: Redis-backed (atomic Lua scripts) and in-memory fallback.
- Circuit closed → open → half-open; fail-open (serve, don't block) on Redis failure, wired via `FailOpenStore` (`adapter/fail-open-store.ts`, which holds the circuit state).
- Rules: consumer-declared `BucketRule[]` — each pairs a `RateLimitRule` with a `bucketOf(item)` closure; the limiter calls `bucketOf` internally (per rule) and returns one ruling. No descriptor/extractor registry (a rule and its bucket derivation are one object), no schema-validation lib (TS types cover config; Express parses request fields).
- `DESIGN.md` is a living WIP — update it as decisions are made.
- Observability: the lib exposes only the `Emitter` event port (no logging/metrics of its own, ioredis-only deps). pino + prom-client live in `demo/` as the consumer mechanisms: wide events (one log line per request), `/metrics`, `LOG_LEVEL`. Prometheus scrape/Grafana are downstream homework, not in-repo.

## Submission rules (must honor)

- Working dir is `rate-limiter/` (solution goes there, alongside `specs/`).
- Repository is created/configured by the user — do not configure git or remotes yourself.
- Required deliverable: `DESIGN.md` explaining architecture, trade-offs, and AI usage.
- Correct code that builds and passes tests is mandatory — non-compiling/test-failing code won't be reviewed.
- Avoid overengineering and AI slop; keep unknown code minimal.

## Critical gotchas (easy to miss)

- **Demo consumes a tarball, not a local path:** The `demo/package.json` dependency is `file:../rate-limiter/rate-limiter-1.0.0.tgz`. After any lib change, you must re-pack and reinstall: run `npm run demo:install` from `demo/` (it packs the lib, then `npm ci` in demo).
- **Integration tests need `--network host`** when running from the dev container so `127.0.0.1:6379` reaches the host's compose Redis. Without it, Redis-backed tests are silently skipped.
- **Tests run serially** (`jest --runInBand`). No parallel execution.
- **No lint script** — only `typecheck` and `test`. Don't look for `npm run lint`.
- **Specs are directories, not files:** `rate-limiter/specs/US-<number>-<name>/spec.md`. Never edit spec files — they're challenge-owned.
- **Jest global setup** (`jest/global-setup.ts`) checks Redis availability and sets a global flag; Redis-dependent tests skip if unavailable.
- **Build cleans `dist/` first** (`rmSync('dist', {recursive:true,force:true})` in `package.json` "build" script).
- **Demo runs on port 3000** by default (`PORT` env var overrides). `npm start` in demo serves HTTP.
- **`trust proxy` is `'loopback'` by default** — only loopback clients can set `X-Forwarded-For`. Set `TRUST_PROXY=true` for real proxies.
- **FailOpenStore and limiter share the same `Emitter`** — wire one instance into both (limiter and FailOpenStore) for correct event emission.
- **Ponytail comments** mark deliberate simplifications with known ceilings. Don't "fix" them without understanding the trade-off.
