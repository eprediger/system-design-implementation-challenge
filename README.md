# Rate Limiter

Server-side API rate limiter (sliding window counter). Implementation and specs live in `rate-limiter/`; architecture and
decisions are recorded in [`rate-limiter/DESIGN.md`](rate-limiter/DESIGN.md).

All commands below assume a shell in `rate-limiter/`.

## Requirements

- Node.js >= 18 + npm, **or** Docker.

## Quick start (native Node)

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/
npm test            # jest --runInBand
```

`npm start` serves the library entry (`dist/index.js`); HTTP behavior is
exercised by the reference demo (below).

## Quick start (Docker)

Build the dev image (base: `node:24-slim`, replaces your local Node/npm):

```sh
docker build -t rate-limiter-dev .
```

Run inside the container by hand, one command at a time:

```sh
docker run -it --rm rate-limiter-dev bash
# inside the container:
npm run typecheck
npm run build
npm test
npx jest src/domain/sliding-window.test.ts   # single suite
```

One-shot (runs the full suite, no shell):

```sh
docker run --rm rate-limiter-dev npm test
```

To iterate on host edits inside the container (bind mount; note
`node_modules` lives in the image — re-run `npm ci` after a fresh mount if
the host has none):

```sh
docker run -it --rm -v "$PWD:/app" -w /app rate-limiter-dev bash
```

## Redis (integration tests)

`npm test` runs the Redis-backed store suite when a Redis server is reachable
at `redis://127.0.0.1:6379` (or `$REDIS_URL`), and skips it silently otherwise.

Start Redis via Docker Compose, from the repo root (parent of `rate-limiter/`):

```sh
docker compose up -d redis
docker compose exec redis redis-cli ping   # PONG
```

When running the suite *from the dev container*, the container's own
`127.0.0.1` doesn't reach the compose service — run on the host network
(Linux; matches the dev image and CI):

```sh
docker run --rm --network host -v "$PWD:/app" -w /app rate-limiter-dev npm test
```

Inspect live counters while tests (or the stress demo, later) run:

```sh
docker compose exec redis redis-cli KEYS 'rl:*'
```

Stop and wipe when done: `docker compose down -v`.

## Reference demo (HTTP)

`demo/` is a separate npm project that consumes the *packed* library by package
name (`import { SlidingWindowLimiter } from 'rate-limiter'`) — the same artifact
shape as a published package. It shows rule authoring (`BucketRule[]`: each rule
is a `bucketOf(item)` closure plus a `RateLimitRule`) and the request/response
wiring around `check(item)`.

From `demo/`:

```sh
npm run demo:install   # npm pack the lib → rate-limiter-1.0.0.tgz → npm ci here
npm test               # supertest suite (per-IP, per-IP+endpoint, 429 + Retry-After)
npm start              # listens on $PORT (default 3000)
```

The running server trusts `X-Forwarded-For` (Express `trust proxy`), so per-IP
rules work through a reverse proxy. Try it:

```sh
curl -i -H 'X-Forwarded-For: 1.2.3.4' http://localhost:3000/api/route
```

## Layout

```
src/
  domain/sliding-window.ts   # core algorithm + rule vocabulary
  domain/rate-limit-result.ts # RateLimitResult value object
  domain/ports.ts            # Store / Clock / IncrementResult ports
  domain/*.test.ts           # co-located tests
  adapter/                   # ports' implementations (memory store, circuit breaker)
```

Tests are co-located next to their subjects. Concurrency/edge suites and the
full build gate must stay green (`npm test`).
