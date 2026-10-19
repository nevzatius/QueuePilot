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
