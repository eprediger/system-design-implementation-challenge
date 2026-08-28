# AGENTS.md

## Project

Server-side API rate limiter (TypeScript). Solution lives in `rate-limiter/`; specs are in `rate-limiter/specs/US-*.md`. Entry point / public API is `src/index.ts`. Human-facing run docs: root `README.md`.

## Commands (run from `rate-limiter/`)

There is no local Node here — things run via Docker (`node:24-slim` dev image):

- `docker build -t rate-limiter-dev .` — build the image (deps installed via `npm ci`).
- `docker run -it --rm rate-limiter-dev bash` — interactive shell; run commands by hand inside: `npm run typecheck`, `npm run build`, `npm test`, `npx jest <file>.test.ts` (single suite).
- One-shot: `docker run --rm rate-limiter-dev npm test`.

Same scripts work on native Node >= 18: `npm run typecheck` (`tsc --noEmit`; there is no lint script), `npm run build` (`tsc` → `dist/`), `npm test` (`jest --runInBand`). `npm start` serves the lib entry only — there is no HTTP server yet.

## Workflow & style

- BDD/TDD: tests written first (red), implementation second (green), given/when/then in `describe`/`it`. Spec acceptance criteria map directly to test cases.
- Tests are co-located: `*.test.ts` sits beside the module it tests under `src/` (jest `roots` = `src/`); the build excludes test files.
- Architecture policy (target): Hexagonal Architecture + DDD — domain core isolated from infrastructure, ports & adapters, framework-agnostic HTTP middleware. Current code does not fully conform yet; convergence is a deferred refactor, a separate task from feature work (don't restructure mid-feature).
- Strict TS, CommonJS. Keep code minimal; mark deliberate corner-cuts with a `ponytail:` comment.

## Structure

- `src/domain/sliding-window.ts` — algorithm + all domain types (`RateLimitRule`, `RateLimitResult`) + driven ports (`Store`, `Clock`). Domain owns its ports; adapters import them.
- `src/adapter/` — `memory-store.ts` (in-memory `Store` impl), `http.ts` (connect-style HTTP middleware, exports `rateLimitMiddleware`), `circuit-breaker.ts`.
- `src/index.ts` — composition root re-exporting the public API.

## Locked-in decisions (do not reinvent)

- Express, ioredis, Jest. Sliding-window counter (O(1) time/space), NOT sliding-window-log (O(n)).
- `Store` interface with two impls: Redis-backed (atomic Lua scripts) and in-memory fallback.
- Circuit breaker closed → open → half-open; fail-open (serve, don't block) on Redis failure. The breaker class exists but is not yet wired into the middleware.
- Rules: global, per-IP, per-endpoint `pathPattern`. No extractor/plugin system, no schema-validation lib (TS types cover config; Express parses request fields).
- `DESIGN.md` is a living WIP — update it as decisions are made.
- Metrics (`/metrics`, prom-client) is deferred, on the roadmap; implement only if time permits.

## Submission rules (must honor)

- Working dir is `rate-limiter/` (solution goes there, alongside `specs/`).
- Repository is created/configured by the user — do not configure git or remotes yourself.
- Required deliverable: `DESIGN.md` explaining architecture, trade-offs, and AI usage.
- Correct code that builds and passes tests is mandatory — non-compiling/test-failing code won't be reviewed.
- Avoid overengineering and AI slop; keep unknown code minimal.