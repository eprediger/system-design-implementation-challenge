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

`npm start` serves the library entry (`dist/index.js`); there is no HTTP
server yet.

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

## Layout

```
src/
  domain/sliding-window.ts   # core algorithm + domain types + Store/Clock ports
  domain/*.test.ts           # co-located tests
  adapter/                   # ports' implementations (memory store, HTTP, circuit breaker)
```

Tests are co-located next to their subjects. Concurrency/edge suites and the
full build gate must stay green (`npm test`).
