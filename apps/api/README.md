# QueuePilot API (B3)

Fastify application using the unchanged contracts and pure domain acceptance/idempotency decisions.

From the repository root, install workspace dependencies, then run:

```powershell
corepack pnpm build
corepack pnpm --filter @queuepilot/api start
```

The executable artifact is `apps/api/dist/server.js`. The root B1 bundler also creates `dist/index.js`,
which currently bundles CommonJS SDKs incorrectly; use the API package's `start` command.
`build.mjs` bundles workspace TypeScript and leaves runtime SDKs in `node_modules`.

For local development, export `QP_ENV=development`, `GCLOUD_PROJECT=demo-queuepilot`,
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`.
The application does not load `.env` automatically. Start the local emulators with the root
`emulators` command. Production must have no emulator overrides or `QP_FAULT_*` variables;
`QP_QUOTA_FAILURE_MODE=open` is rejected in production. Configuration validation errors never echo values.

| Endpoint | Authentication / behavior |
|---|---|
| `GET /health` | Public liveness; no dependency IO |
| `GET /ready` | Public Firestore readiness; sanitized 503 on failure |
| `GET /api/v1/me` | Verified Google token; membership can be null |
| `POST /api/v1/session/bootstrap` | Verified Google token; absent body or `{}`; creates sandbox member only |
| `POST /api/v1/requests` | Active membership/tenant; required `Idempotency-Key`; durable 202 with Location |
| `GET /api/v1/requests` | Defaults to own requests; `scope=tenant` needs uncached verified admin membership |
| `GET /api/v1/requests/:requestId` | Own request or same-tenant admin; hidden resources return 404 |
| `GET /api/v1/metrics` | Counts for the verified tenant, 5s instance cache and single-flight |

Listing supports the contract's `limit` and opaque `cursor`; a cursor binds to the tenant and
visibility scope. Timestamp and document ID ordering prevent tied timestamps from repeating pages.
No endpoint accepts client-selected ownership, roles or tenant IDs. An existing operator-granted
membership is preserved by bootstrap; bootstrap never grants or upgrades admin.

All errors use RFC 9457 `application/problem+json`, stable contract codes and a server-generated
`correlationId` echoed in `X-Correlation-Id`. Logs contain method, correlation ID and safe diagnostic
fields; raw request bodies, URLs and dependency errors are omitted. Credential/cookie/description
paths are redacted. No token revocation check or Firebase custom-claim authorization is used.

## Reliability and B4/B5 seams

`FirestoreRequestRepository.submit` atomically persists the idempotency record, request and
domain-generated `ACCEPTED-s1` event in one transaction. Domain `decideIdempotency` executes inside
the retried transaction, including logical-expiry takeover. Enqueue happens only after commit,
only for the creator, with a 2s deadline. Replays do not create tasks. An enqueue error is logged;
no request status or dispatch metadata is written afterward (ARCHITECTURE section 4, ADR-017).
The initial watchdog and budgets come from `planAcceptance`.

`QueuePort.enqueue(payload, signal)` is the B4 seam. The default `deferredQueue` throws locally;
accepted requests stay durable and require B4's queue adapter and reconciler for processing.
No Cloud Tasks client, worker, reconciler, delivery model, probe, retry route or state transition
implementation is introduced in B3. B4 should use deterministic `taskName` from the domain,
honor the AbortSignal, and preserve commit-before-create ordering.

`QuotaStore` and `RateLimiter` are the B5 seams. Enforced quotas currently return
`503 QUOTA_UNAVAILABLE`, with Retry-After. Operator-provisioned `quotaMode=none` tenants can submit.
The default local burst limiter applies the degraded per-instance limit and logs this at startup.
Positive membership/tenant cache TTL is at most 30s; negative results are not cached and
privileged reads always refresh. Read failures fail closed; expired entries are never used.

Admission applies a 40/s bucket, 32 commit slots (100ms wait) and a cached global ACCEPTED backlog
guard (20,000). Bootstrap shares the bucket/semaphore and has separate UID/IP limits.
An unavailable backlog metric is skipped as permitted by ADR-012.

Status counts use Firestore aggregate count queries. The `stuck` value reads projected watchdog
timestamps from tenant/status-filtered non-terminal requests because existing indexes exempt
watchdogAt. This avoids an infrastructure change, but costs one document read per pending request
on a cache miss. A more efficient tenant/watchdog count needs an integration-owner index decision.

## Browser access, client IP and Redis timing (B9-4)

All three settings are validated at startup with constant messages that never echo a value.

| Variable | Default | Rules |
|---|---|---|
| `QP_CORS_ORIGINS` | empty (no cross-origin access) | Comma separated exact `https` origins, at most 10: no `*`, path, trailing slash, userinfo or default port. `http://localhost` and `http://127.0.0.1` (any port) only outside production. Production needs at least one entry once the web is hosted on another origin (Firebase Hosting); an empty list is valid and means same-origin only. |
| `TRUST_PROXY_HOPS` | `0` | Integer 0 to 5 (`true`, negatives, decimals and text are rejected). 0 ignores `X-Forwarded-For`. **Render: 3.** |
| `QP_REDIS_CONNECT_TIMEOUT_MS` | `1500` | Integer 100 to 3000. |

**CORS** (`src/cors.ts`, API only; the worker is called by QStash and sends no CORS headers). An allowed origin is answered
with that exact origin; every other origin gets no `Access-Control-*` header (never `*`, never an echo). Every response
carries `Vary: Origin`. A preflight of an allowed origin gets `204` with `GET, POST, OPTIONS`,
`Authorization, Content-Type, Idempotency-Key`, `Access-Control-Max-Age: 600`, and no credentials (auth is a bearer token); it is
answered before authentication. `Retry-After`, `Idempotent-Replayed`, `X-Correlation-Id` and `Location` are exposed to scripts.
CORS is a browser rule, not authentication: a request without a valid token is rejected whatever its `Origin`.

**Client IP** (`src/proxy.ts`). Behind Render the socket address is loopback and `X-Forwarded-For` arrives as
`<spoofed...>, <client>, <cloudflare>, <render>`; Render does not strip spoofed values (ADR-019 spike, n=1). The client is the
4th address from the right counting the socket as hop 0, so Render uses `TRUST_PROXY_HOPS=3`. **Re-verify this live in B9-9 and
whenever the platform changes.** Implementation notes:

- Fastify 5.12 maps a *numeric* `trustProxy` to "trust nobody", so the API passes a function built from the validated integer
  (`hop < hops`). It is never `true`.
- The header is honoured only when the socket peer is private, loopback or link-local, and only when it holds at least `hops`
  entries; otherwise `request.ip` is the socket address, never a client-chosen value.
- Everything uses `request.ip` (today only the bootstrap IP limiter); no code reads `X-Forwarded-For` by hand.

**Redis connect timeout.** The old fixed 100 ms made every cold start fail closed. Upstash free measured a cold connect of about
404 ms, warm 24-40 ms, commands about 2 ms (ADR-019 spike, small sample). Connect and command now have separate budgets: connect
`QP_REDIS_CONNECT_TIMEOUT_MS` (1500 ms), each command 100 ms. A background pre-warm starts at boot; it never blocks or fails boot
and never changes request behaviour. Fail-closed is unchanged: if Redis cannot be reached within the budget, enforced quotas
answer `503 QUOTA_UNAVAILABLE` and burst limits fall back to per-instance limits. Worst case with Redis down and no open
circuit is rate limiter plus quota, each connect + command: 2 x 1.6 s = 3.2 s, inside the 15 s API timeout (ARCHITECTURE section 15);
after 5 failures the circuit opens for 30 s and requests fail immediately.

## Verification

```powershell
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
node apps/api/test/build-smoke.mjs
corepack pnpm --filter @queuepilot/api test:integration
```

The API integration command starts local Auth/Firestore emulators with a demo project only. It
does not require Redis or cloud credentials. Tests use verified emulator Google identities, real
Firestore transactions, a fake clock and a recording/failing QueuePort. B4's LocalDispatchQueue
is deliberately not implemented here. The root integration command continues to run the existing
foundation checks and requires local Redis. Add the API integration glob to root CI at integration.

On this Windows/Java 26 host, Firebase CLI reports emulator shutdown but can leave its Java
child listening on 8080. Stop only the emulator child created by the test before another run;
never terminate an unrelated listener. This is a local tooling limitation, not a test skip.
