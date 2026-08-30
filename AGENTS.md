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
- `src/domain/ports.ts` — driven ports (`Store`, `Clock`, `IncrementResult`). Domain owns its ports; adapters import them.
- `src/adapter/` — `memory-store.ts` (in-memory `Store` impl), `circuit-breaker.ts`, `fail-open-store.ts` (`Store` that serves from memory with a WARN when the primary is down or the circuit is open).
- `src/index.ts` — composition root re-exporting the public API.
- `demo/` (outside the lib) — reference HTTP consumer: consumes the packed `rate-limiter` tarball by package name; `createApp(rules: BucketRule[])` builds the limiter, middleware calls `check(req)` and renders headers/429.

## Locked-in decisions (do not reinvent)

- Express, ioredis, Jest. Sliding-window counter (O(1) time/space), NOT sliding-window-log (O(n)).
- `Store` interface with two impls: Redis-backed (atomic Lua scripts) and in-memory fallback.
- Circuit breaker closed → open → half-open; fail-open (serve, don't block) on Redis failure, wired via `FailOpenStore` (`adapter/fail-open-store.ts`).
- Rules: consumer-declared `BucketRule[]` — each pairs a `RateLimitRule` with a `bucketOf(item)` closure; the limiter calls `bucketOf` internally (per rule) and returns one ruling. No descriptor/extractor registry (a rule and its bucket derivation are one object), no schema-validation lib (TS types cover config; Express parses request fields).
- `DESIGN.md` is a living WIP — update it as decisions are made.
- Metrics (`/metrics`, prom-client) is deferred, on the roadmap; implement only if time permits.

## Submission rules (must honor)

- Working dir is `rate-limiter/` (solution goes there, alongside `specs/`).
- Repository is created/configured by the user — do not configure git or remotes yourself.
- Required deliverable: `DESIGN.md` explaining architecture, trade-offs, and AI usage.
- Correct code that builds and passes tests is mandatory — non-compiling/test-failing code won't be reviewed.
- Avoid overengineering and AI slop; keep unknown code minimal.