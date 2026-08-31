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

Inspect live counters while tests (or the stress demo) run:

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
npm test               # supertest suites (server, observability, distributed stress, failover)
npm start              # listens on $PORT (default 3000)
```

Two Redis-gated suites run when a Redis is reachable (skipped otherwise):
`stress.test.ts` launches two server instances sharing one Redis and asserts the
per-client ceiling holds **globally** (exactly 100 of 200 requests allowed
across both); `failover.test.ts` fronts Redis with an in-test TCP relay, cuts
it mid-load (requests keep flowing from the in-memory fallback), then restores
it and asserts the circuit re-seats on Redis. Run them via the full gate:

```sh
docker run --rm --network host -v "$PWD:/app" -w /app/demo rate-limiter-dev npm test   # with compose redis up
```

While the circuit is open the fallback is per-instance memory, so during an
outage a client splitting traffic across instances can exceed the configured
limit — enforcement degrades to per-instance until Redis returns. Counts held
in the fallback during the outage are discarded when Redis re-seats; the shared
counters resume from Redis's own state (fail-open favors availability over
state continuity).

The demo also demonstrates fault tolerance (US-5). Without `REDIS_URL` it uses
an in-memory store directly. Set it to run the full stack — Redis first:

```sh
docker compose exec redis redis-cli ping   # confirm health
REDIS_URL=redis://127.0.0.1:6379 npm start
```

The limiter then backs on `FailOpenStore`: `RedisStore` behind a circuit
breaker with an in-memory fallback. Kill Redis (`docker compose stop redis`)
and requests keep flowing, rate limited from memory. A real primary failure
logs one WARN as the circuit trips; while it stays open, fallback is silent (no
per-request log spam). Restart Redis and the next half-open probe re-seats it —
one in-flight probe at a time, concurrent calls wait on the fallback.

By default the server only trusts `X-Forwarded-For` from a loopback client
(Express `trust proxy: 'loopback'`), so a remote caller cannot spoof its way
out of per-IP limits. Deploy behind a real forward proxy and opt into trusting
all hops with `TRUST_PROXY=true`. Per-IP **and** per-`IP:METHOD /path` rules are
configured; endpoint buckets canonicalize the path (percent-decoding, duplicate
slashes collapsed) so spelling variants share one counter. Try it:

```sh
curl -i -H 'X-Forwarded-For: 1.2.3.4' http://localhost:3000/api/route
```

## Metrics & logs (demo)

The demo runs US-7 observability on top of the library's `Emitter` event port
(the library itself only emits; it takes no logging or metrics dependency).
Wire the same `Emitter` into the limiter, circuit breaker, and fail-open store
to attach your own mechanisms.

- **Logs** — one *wide event* per request, written once as the response
  finishes ([structured JSON](https://github.com/pinojs/pino), ISO timestamp):
  an allowed request logs `info`, a throttled one `warn` (with
  `rate_limit.bucket/rule/allowed/retry_after` plus `ip`, `request_id`,
  `user_id`), and an unhandled error `error` with `error.stack`. Circuit-breaker
  open/close stay separate lifecycle lines. Filter with `LOG_LEVEL` (default
  `info`, e.g. `LOG_LEVEL=warn`).
- **Metrics** — `GET /metrics` exposes a Prometheus scrape ([prom-client](https://prometheus.io/docs/guides/nodejs/)):
  counters `rate_limit_requests_total`, `rate_limit_allowed_total`,
  `rate_limit_throttled_total`, `rate_limit_errors_total{type}`, `rate_limit_fallback_total{reason}`,
  `rate_limit_check_ms` (algorithm check) and `rate_limit_store_op_ms{operation}`.
- `store_op_ms` comes from a `timedStore` decorator wrapping the store; the
  fallback path is counted per serve (`reason="error"|"open"`) yet logged once
  per real trip, so an outage flags on the wide event without a log storm.

## Layout

```
src/
  domain/sliding-window.ts   # core algorithm + rule vocabulary
  domain/rate-limit-result.ts # RateLimitResult value object
  domain/ports.ts            # Store / Clock / IncrementResult ports
  domain/events.ts           # Emitter observability port (+ LimiterEvent union)
  domain/*.test.ts           # co-located tests
  adapter/                   # ports' implementations (memory store, circuit breaker, fail-open store)
  index.ts                   # composition root (public API)
demo/src/
  server.ts                  # HTTP consumer (createApp with per-IP / per-endpoint rules)
  logger.ts / metrics.ts / wide-event.ts   # pino + prom-client observability
  stress.test.ts / failover.test.ts   # Redis-gated stress + failover suites
```

Tests are co-located next to their subjects. Concurrency/edge suites and the
full build gate must stay green (`npm test`).
