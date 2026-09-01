# Demo (reference HTTP consumer)

`demo/` is a separate npm project that consumes the *packed* library by package name
(`import { SlidingWindowLimiter } from 'rate-limiter'`) — the same artifact shape as a
published package. It shows rule authoring (`BucketRule[]`: each rule is a `bucketOf(item)`
closure plus a `RateLimitRule`) and the request/response wiring around `check(item)`.

## Run

From `demo/`:

```sh
npm run demo:install   # npm pack the lib → rate-limiter-1.0.0.tgz → npm ci here
npm test               # supertest suites (server, observability, distributed stress, failover)
npm start              # listens on $PORT (default 3000)
```

Two Redis-gated suites run when a Redis is reachable at `redis://127.0.0.1:6379`
(`$REDIS_URL`), skipped otherwise: `stress.test.ts` launches two server instances sharing
one Redis and asserts the per-client ceiling holds **globally** (exactly 100 of 200
requests allowed across both); `failover.test.ts` fronts Redis with an in-test TCP relay,
cuts it mid-load (requests keep flowing from the in-memory fallback), then restores it and
asserts the circuit re-seats on Redis. From the dev container, reach the host's compose
Redis with:

```sh
docker run --rm --network host -v "$PWD:/app" -w /app/demo rate-limiter-dev npm test
```

## Fault tolerance (US-5)

Without `REDIS_URL` the demo uses an in-memory store directly. Set it to run the full
stack — Redis first:

```sh
docker compose exec redis redis-cli ping   # confirm health
REDIS_URL=redis://127.0.0.1:6379 npm start
```

The limiter then backs on `FailOpenStore`: an in-memory fallback in front of `RedisStore`,
holding the circuit state itself. Kill Redis (`docker compose stop redis`) and requests
keep flowing, rate limited from memory. A real primary failure logs one WARN as the
circuit trips; while it stays open, fallback is silent (no per-request log spam). Restart
Redis and the next half-open probe re-seats it — one in-flight probe at a time, concurrent
calls wait on the fallback.

While the circuit is open the fallback is per-instance memory, so during an outage a client
splitting traffic across instances can exceed the configured limit — enforcement degrades
to per-instance until Redis returns. Counts held in the fallback during the outage are
discarded when Redis re-seats; the shared counters resume from Redis's own state
(fail-open favors availability over state continuity).

## Trusted proxies

By default the server only trusts `X-Forwarded-For` from a loopback client
(Express `trust proxy: 'loopback'`), so a remote caller cannot spoof its way out of
per-IP limits. Deploy behind a real forward proxy and opt into trusting all hops with
`TRUST_PROXY=true`. Per-IP **and** per-`IP:METHOD /path` rules are configured; endpoint
buckets canonicalize the path (percent-decoding, duplicate slashes collapsed) so spelling
variants share one counter. Try it:

```sh
curl -i -H 'X-Forwarded-For: 1.2.3.4' http://localhost:3000/api/route
```

## Observability (US-7)

The demo runs observability on top of the library's `Emitter` event port — the library
itself only emits; it takes no logging or metrics dependency. Wire the same `Emitter`
into the limiter and fail-open store to attach your own mechanisms.

- **Logs** — one *wide event* per request, written once as the response
  finishes ([structured JSON](https://github.com/pinojs/pino), ISO timestamp):
  an allowed request logs `info`, a throttled one `warn` (with
  `rate_limit.bucket/rule/allowed/retry_after` plus `ip`, `request_id`,
  `user_id`), and an unhandled error `error` with `error.stack`. Filter with
  `LOG_LEVEL` (default `info`, e.g. `LOG_LEVEL=warn`).
- **Metrics** — `GET /metrics` exposes a Prometheus scrape ([prom-client](https://prometheus.io/docs/guides/nodejs/)):
  counters `rate_limit_requests_total`, `rate_limit_allowed_total`,
  `rate_limit_throttled_total`, `rate_limit_errors_total{type}`, `rate_limit_fallback_total{reason}`,
  `rate_limit_check_ms` (algorithm check) and `rate_limit_store_op_ms{operation}`.
- `store_op_ms` comes from a `timedStore` decorator wrapping the store; the
  fallback path is counted per serve (`reason="error"|"open"`) yet logged once
  per real trip, so an outage flags on the wide event without a log storm.

## Configuration

Configuration is split into two layers. All values are validated at startup; an invalid
value aborts with a clear message (fail-fast) rather than silently falling back. Every
variable, with its default and purpose, is annotated in the matching `.env.example`.

- **Demo app (process-level)** — reads its configuration from the environment, optionally
  loaded from `demo/.env`. Copy `demo/.env.example` to `demo/.env` and adjust. `dotenv`
  loads the file; it never overrides variables already set in the environment (so
  Compose-level values win).
- **Compose stack (host/build-level)** — Compose reads `./.env` next to `compose.yaml` for
  its own interpolation. Copy `.env.example` to `.env` and adjust.

The rate-limit rules remain code-authored in `src/server.ts` (a `BucketRule[]` with
`bucketOf` closures) — deliberately not env-configurable, since each rule carries a
bucket-derivation closure and env-encoding them would not scale as rules grow.