# QueuePilot worker (B4)

Private Fastify endpoints: `POST /internal/tasks` (Cloud Tasks), `POST /internal/reconcile`
(Cloud Scheduler), `GET /ready` (Firestore readiness), `GET /health` (liveness).
Build with `corepack pnpm --filter @queuepilot/worker build`; run `node apps/worker/dist/server.js`
from the repository root. Node 24 is required.

## Authentication and queue configuration

The default worker auth mode is `oidc`, including in development. It verifies Google's signature,
expiry, audience, issuer, verified email and the endpoint's service-account email. Task callers use
`QP_TASKS_INVOKER_SA`. Scheduler callers use `QP_SCHEDULER_SA`, defaulting to
`qp-scheduler-sa@${GCLOUD_PROJECT}.iam.gserviceaccount.com`. Cloud Run must also remain private.
The B2 scripts already provision these identities and `/internal/reconcile` every minute.

Cloud configuration (B2 names): `QP_QUEUE_ADAPTER=cloud`, `QP_WORKER_URL` (canonical HTTPS origin,
without trailing slash), `QP_TASKS_OIDC_AUDIENCE` (same origin), `QP_TASKS_INVOKER_SA`,
`GCLOUD_PROJECT`, `QP_REGION=europe-west1`, `QP_TASKS_QUEUE=qp-process`,
`QP_TASK_DISPATCH_DEADLINE_SECONDS=30`. Production defaults to cloud and rejects local adapters,
local auth, emulator overrides and **any** `QP_FAULT_*` environment variable, even `false`.
It refuses to start if cloud/OIDC configuration is incomplete.

QStash configuration (ADR-019 free profile; the `QStashQueue` adapter publishes to QStash, the worker verifies its calls by signature, see below):
- `QP_QUEUE_ADAPTER=qstash`: select the QStash backend (`local` | `cloud` | `qstash`).
- `QSTASH_TOKEN`: secret, publish token for the QStash API.
- `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY`: secrets, both accepted by the worker signature verifier so key rotation never drops deliveries.
- `QP_WORKER_URL`: the PUBLIC worker origin QStash calls (must be `https` in production; no path, no trailing slash). Shared with the other backends. Under qstash it is also what the verifier compares the token's `sub` with, so it must be the exact origin QStash was given, not an internal Render hostname.
- `QP_WORKER_AUTH_MODE`: `oidc` | `local` | `qstash`. Defaults to `qstash` under the qstash adapter and `oidc` otherwise. Production requires the mode that matches the adapter (cloud -> `oidc`, qstash -> `qstash`); a mismatch in any environment fails with a constant message, and `local` stays rejected in production. `QP_TASKS_OIDC_AUDIENCE`, `QP_TASKS_INVOKER_SA` and `QP_SCHEDULER_SA` are not needed under qstash and are rejected in production as mixed configuration.
- `QP_QSTASH_RETRIES`: delivery retries, integer 0-3, default 2.
- `QSTASH_URL`: optional QStash API origin, default `https://qstash.upstash.io`. QStash tokens are regional, so use the URL shown next to your token (for example `https://qstash-eu-central-1.upstash.io`). Must be an `https` origin (no path, query, credentials or trailing slash). A blank value counts as unset (the default). Not a secret, but it is a QStash-only setting: Cloud Tasks production rejects it as mixed configuration. Verify in B9-9 that the region matches the token.
- `QP_QSTASH_TIMEOUT`: per-delivery timeout as `<number><s|m|h>` with exactly one unit (`90s`, `5m`; the format the QStash API documents), default `90s`, between 60 s and 15 min inclusive. A bare number is rejected because QStash answers 400; `1m30s`, `1.5s` and `90000ms` are rejected because they are undocumented. The lower bound covers a Render free cold start (about 8-14 s measured, up to about 50 s per Render docs) plus processing.

### QStash caller verification (B9-3)

With `QP_WORKER_AUTH_MODE=qstash` both `POST /internal/tasks` and `POST /internal/reconcile` (the QStash schedule tick)
require an `Upstash-Signature` JWT. `createCallerVerifier` builds it before any SDK client or Firestore access.
- Algorithm HS256 only (`none` and every other `alg` are refused, and so is a header with `crit`), HMAC over `header.payload` with the current
  signing key, then the next one (rotation), compared in constant time. The keys are used as UTF-8 text, exactly as configured.
- Claims: `iss` is `Upstash`; `sub` equals `QP_WORKER_URL` + the route path exactly (`/internal/tasks` or
  `/internal/reconcile`, each route its own), never derived from `Host` or `X-Forwarded-*`; `exp` is required and
  `nbf` enforced when present, with a 30 s clock tolerance (`QSTASH_CLOCK_TOLERANCE_SECONDS`); `body` equals the
  base64url SHA-256 of the exact raw bytes received (empty body hashes as the empty string; a trailing `=` is tolerated, as in QStash's SDK).
- The raw body is kept for these two routes only (an encapsulated Fastify scope with a buffer content-type parser
  for every content type); the JSON is parsed after verification, so an unsigned request gets 401 even with a malformed body.
  Failures that fire before verification can run (an invalid `Content-Type`, a body over the 4096-byte limit, a `Content-Length`
  that does not match the body) are mapped to the same 401 in the error handler, logged as `CALLER_REJECTED` / `BAD_FORMAT`; a
  signed request that fails this way is also 401, because its signature cannot be checked.
- In this mode only `/health`, `/ready` and the two routes above skip the bearer check; any other route is refused (403).
- Signing keys must not have leading or trailing whitespace (config error naming only the variable): the HMAC uses them as given.
- Every failure answers `401 {"code":"UNAUTHENTICATED"}`. The log line carries only `CALLER_REJECTED` and a code
  (`MISSING_HEADER`, `BAD_FORMAT`, `BAD_SIGNATURE`, `BAD_CLAIM`, `EXPIRED`, `BODY_MISMATCH`), never the token, a key or a claim value.
  The OIDC path keeps answering 403.
- `jti` is not tracked: a replay is absorbed by idempotency and leases (ADR-017).
- `Retry-After` (seconds) is sent on every 409 and 503 answer from the two internal routes (both auth modes): 60 on
  409 (`LEASE_MS`, the holder's lease), 300 on 503 (`RETRY_WATCHDOG_MS`). QStash honoured it in the ADR-019 spike.
  `Upstash-Retried` is not read yet.

In the free profile all secrets (`QSTASH_*`, `REDIS_URL`) live as Render secret environment variables; there is no Secret Manager.
Production rejects the local queue, missing or blank QStash settings, a non-HTTPS worker URL, and mixed settings
(QStash with `QP_TASKS_*`, `QP_SCHEDULER_SA` or `QP_REGION`; Cloud Tasks with `QSTASH_*` or `QP_QSTASH_*`).
Production also requires `REDIS_URL` to use `rediss:` (TLS).

Log redaction is NOT generic. The logger censors only these key names, at the top level and one level deep
(`*.key`): `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `REDIS_URL`, plus the
existing `authorization`, `cookie(s)` and `description` paths. A credential under any other key name or deeper
nesting is logged in clear. Convention: never log config objects; log `redactConfig(config)` if a dump is needed.
Validation errors are constant messages and never carry the input or a cause.

The queue accepts an injected Tasks SDK-shaped client. Its default transport uses the Cloud Tasks
v2 REST API with lazily resolved Application Default Credentials through `google-auth-library`.
No credentials are resolved at startup. Requests have a 2s transport timeout; enqueue callers also
enforce a 2s wall-clock deadline, with cancellation. The SDK package could not be installed in this
offline environment, so no `@google-cloud/tasks` dependency was added. Live transport verification
remains part of the owner's C1–C9 gate.

## Local emulators

Do not launch another emulator on the shared development machine. With the existing emulator:

```powershell
$env:QP_ENV='development'
$env:GCLOUD_PROJECT='demo-queuepilot'
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:QP_QUEUE_ADAPTER='local'
$env:QP_WORKER_AUTH_MODE='local'
$env:QP_WORKER_URL='http://127.0.0.1:18281'
$env:PORT='18281'
node apps/worker/dist/server.js
```

Local auth bypass is explicit and requires both a demo project and a loopback emulator. For the API,
set the same queue adapter and worker URL, and use its own free port. Both processes pump their local
in-memory queues over HTTP. These queues are not shared or durable; the Firestore watchdog recovers
lost enqueues. A worker probe cannot see the API's in-memory tasks, so local multi-process operation
can place extra harmless orders. Tests inject one shared LocalDispatchQueue and a fake Clock.
Local development faults: `QP_FAULT_CREATE=fail|ambiguous`,
`QP_FAULT_PROBE_PERMISSION_DENIED=1`. There is no fault-control HTTP endpoint.

## Recovery and tests

Only domain decisions select transitions. Every decision is rerun on a fresh transactional read.
State, result and deterministic timeline events commit together; a task gets a successful response
after that commit. Reconciler dispatch orders commit before task creation. Enqueue outcomes only
change `dispatch.lastError`. Prompt orders use 5m watchdogs, attention orders 30m; dispatch trouble
never fails processing. A bounded scan reads 25 requests per shard (4 shards). Redis is not used.

Unit tests run through `corepack pnpm test`. B4 emulator tests are in
`test/integration/worker.test.ts` and included by the root integration config. Set the emulator
environment above and `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`, then run directly:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts apps/worker/test/integration/worker.test.ts apps/api/test/integration/backend.test.ts
```

The tests use UUID request/tenant/key identifiers and never wipe shared emulator data.
The 500-task paused-queue case has a 120s timeout. Existing domain 5040-interleaving and
800-schedule fuzz suites remain unchanged and run in the root unit gate. The adapter regression
suite mirrors the reported race scenarios with real Firestore transactions, including concurrent
workers/reconcilers, stalled creates, stale wakeups, queue outages and fencing.

After building, `node apps/worker/test/build-smoke.mjs` reserves an ephemeral port, checks readiness
and both unauthenticated private endpoints, then requests orderly shutdown over parent IPC.
It never kills a process. The build gate must precede the smoke so it exercises the current artifact.
