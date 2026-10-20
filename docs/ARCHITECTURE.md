# QueuePilot Architecture (v0.2, frozen)

Single source of truth for design. Agents read only the sections they need (`grep -n "^## "`).
Decisions and their rationale are in `docs/DECISIONS.md`. Do not restate them elsewhere.

## 1. Scope

A request ingestion and asynchronous processing platform. The MVP demonstrates one generic workflow:
**burst intake → durable acceptance → rate-limited async triage → status tracking**.
Non-goals for the MVP: multi-region, exactly-once delivery, external side effects, and Kubernetes, Kafka or microservices.

## 2. System overview

```mermaid
flowchart LR
  U[React SPA] -->|static + /api/** rewrite| H[Firebase Hosting]
  U -->|Google sign-in| FA[Firebase Auth]
  H --> API[Cloud Run qp-api: public, app-level auth]
  API --> FS[(Firestore: source of truth)]
  API --> R[(Upstash Redis: limits + cache only)]
  API -->|createTask| CT[[Cloud Tasks qp-process]]
  CT -->|HTTP + OIDC| W[Cloud Run qp-worker: IAM-only]
  CS[Cloud Scheduler 1/min] -->|OIDC /internal/reconcile| W
  W --> FS
  W -->|getTask / createTask| CT
```

Region: `europe-west1` for Firestore, Cloud Run and Cloud Tasks (irreversible for Firestore).

## 3. Repository layout and dependency rules

```
apps/web        React+Vite+Tailwind     -> contracts only
apps/api        Fastify composition root -> core, domain, contracts
apps/worker     Fastify composition root -> core, domain, contracts
packages/contracts  Zod schemas, DTOs, error codes, TaskPayload (deps: zod)
packages/domain     Pure logic: decision tables, triage rules, fingerprint, idempotency expiry (no IO)
packages/core       IO adapters: config, log, auth, membership, requests repo, idempotency,
                    queue (CloudTasks + LocalDispatchQueue), processing, reconciler,
                    admission, ratelimit/quota, cache, metrics
tests/integration   Firestore/Auth emulator + Redis + LocalDispatchQueue (fake Clock)
tests/load          k6 scripts, verify.ts, sampler, results/*.json
infra/              gcloud scripts, firestore.rules, firestore.indexes.json, queue config
```

- Imports flow only downward: `apps → core → domain → contracts`. Domain never imports IO.
- Interfaces exist only at IO seams: `QueuePort`, `RateLimiter`, `QuotaStore`, `Cache`, `RequestRepository`, `IdempotencyStore`, `MembershipStore`, `Clock`.
- Errors use RFC 9457 Problem Details with `code` and `correlationId`. Stack traces are never exposed.
- The API is versioned under `/api/v1`. Changes inside v1 are additive only.
- Firestore documents carry `schemaVersion`. Changes are additive only and are read through Zod at the repository boundary.

## 4. Request lifecycle

1. The API verifies the token, then membership (§11), then the kill switch, then Zod validation, then rate limit and quota (§12), then admission (§10).
2. One atomic batch `create()`: `idempotencyKeys/{h}` + `requests/{id}` (`ACCEPTED`, `seq=1`, `watchdogAt=now+60s`) + `events/ACCEPTED`.
   **Once this commit succeeds, the request is durably accepted.** Commit failure or timeout → `503`. The client retries with the same key.
3. `createTask r-{id}-1` with a 2 s timeout. A failure is logged only; the reconciler recovers it. No status write follows.
4. Respond `202 Accepted` with `requestId` and `Location`. Meaning: persisted, will be processed at least once, not yet processed.
5. Worker: lease txn → deterministic triage (≤20 s) → completion txn with `leaseId` fencing → `200`.

## 5. Data model (Firestore)

| Collection | Key | Main fields | Notes |
|---|---|---|---|
| `tenants/{tenantId}` | slug | `name, status(active/suspended), openSignup, limits{submitPerMin, submitPerDayUser, submitPerDayTenant}, quotaMode(enforced/none)` | `sandbox` (open), `loadtest` (operator-only, `quotaMode:none`) |
| `memberships/{uid}` | uid | `tenantId, role(member/admin), status(active/suspended), createdBy(bootstrap/operator), updatedAt` | No PII. Never client-writable |
| `requests/{uuid}` | UUIDv4 | `tenantId, createdBy, type, title, description, priority, attributes, status, statusReason?, processing{attempts, leaseId?, leaseExpiresAt?, lastError?, duplicateDeliveries}, dispatch{seq, deliveredSeq, checks, lastError?}, watchdogAt?, watchdogShard(0..3), rulesVersion, result?, timestamps, correlationId, source(ui/api/loadtest), expiresAt?(loadtest only), schemaVersion` | |
| `requests/{id}/events/{eventId}` | `{type}-a{attempt}` / `-s{seq}` | `type, at, actor, attempt, seq, details, correlationId, expiresAt?` | Deterministic IDs make writes idempotent |
| `idempotencyKeys/{sha256(tenant:uid:key)}` | hash | `requestId, payloadFingerprint, createdAt, expiresAt(=+24h)` | TTL policy on `expiresAt` |

Firestore security rules deny all client access. Only the backend reads and writes, through the Admin SDK.

## 6. State machine

Stored `status` values: `ACCEPTED | PROCESSING | COMPLETED | FAILED`.
UI-only derived views: `QUEUED` (ACCEPTED, attempts=0) and `RETRYING` (ACCEPTED, attempts>0).
Constants: `MAX_ATTEMPTS=5`, `MAX_DISPATCH=3` (prompt orders), `ATTENTION_INTERVAL=30m`, `LEASE=60s`, `PROC_TIMEOUT=20s`.

| # | From | Trigger | Guard | To | Effects |
|---|---|---|---|---|---|
| S1 | ∅ | POST | key absent or logically expired | ACCEPTED | seq=1, deliveredSeq=0, attempts=0, watchdog=+60s |
| S2 | ACCEPTED | delivery(seq) | seq≤dispatch.seq, attempts<MAX | PROCESSING | attempts++, new leaseId, leaseExp=+60s, deliveredSeq=max(deliveredSeq, seq), checks=0, attentionSince=null, watchdog=leaseExp+30s |
| S3 | PROCESSING | delivery(seq) | lease expired, seq≤dispatch.seq, attempts<MAX | PROCESSING | same as S2 + `LEASE_TAKEOVER` event |
| S4 | PROCESSING | success | leaseId matches | COMPLETED | result, completedAt, delete watchdog |
| S5 | PROCESSING | transient error | leaseId matches, attempts<MAX | ACCEPTED | clear lease, lastError, watchdog=+5m. HTTP 503 |
| S6 | PROCESSING | transient error | leaseId matches, attempts≥MAX | FAILED | `ATTEMPTS_EXHAUSTED`. HTTP 200 |
| S7 | PROCESSING | permanent error | leaseId matches | FAILED | `PERMANENT_ERROR`. HTTP 200 |
| S8 | ACCEPTED/PROCESSING (lease expired) | delivery or reconciler | attempts≥MAX | FAILED | `ATTEMPTS_EXHAUSTED` |
| S9 | ACCEPTED/PROCESSING (lease expired) | reconciler: no task observed (NOT_FOUND or UNKNOWN) | seq<maxSeq | unchanged | **dispatch order**: txn seq++ and watchdog=+5m, then createTask for the new seq (ADR-017) |
| S10 | same | same | seq≥maxSeq | unchanged (non-terminal) | **attention order**: same as S9, plus `dispatch.attentionSince` set (first time) and watchdog=+30m. Never FAILED. Cleared by the next delivery that acquires a lease |
| S11 | COMPLETED/FAILED | any | – | unchanged | absorbing |
| S12 (P1) | FAILED | admin retry | role=admin (uncached check) | ACCEPTED | new retry budget epoch: `processing.maxAttempts = attempts + MAX_ATTEMPTS`, `seq++`, `dispatch.maxSeq = seq + MAX_DISPATCH - 1`. Not an MVP feature; needs an ADR before it is enabled (ADR-015) |

**Dispatch is a wake-up, never a correctness signal (ADR-017).** A Cloud Tasks task only wakes a worker. Firestore alone decides whether business logic runs: the lease (I4), the attempt budget (I5) and terminal absorption (I3). Any task of a runnable request may process it, whatever its `seq`; every extra task is absorbed. No decision depends on `GetTask`, `ALREADY_EXISTS`, tombstones or their duration.

**Dispatch order and unique creator.** A dispatch order commits `seq++` (and the watchdog) in one transaction **before** `createTask`. The name `r-{id}-{seq}` therefore has exactly one creator: the API for seq 1 (after S1), and the transaction that committed seq n for n≥2. Two reconcilers never share a name. A stalled creator can only add a late, harmless extra task. `ALREADY_EXISTS` can only answer the creator's own earlier call, so it counts as CREATED.

**Worker, `decideDelivery(doc, delivery, now)`** (first match wins):

| Condition | Decision | HTTP |
|---|---|---|
| no document | ORPHAN | 200 |
| terminal | DUPLICATE_SUPPRESSED (duplicateDeliveries++) | 200 |
| seq > dispatch.seq (anomaly: tasks are created after their seq commits) | FUTURE_DISPATCH (no write, ERROR log) | 200 |
| PROCESSING and lease valid | LEASE_HELD (no write) | **409** |
| attempts ≥ maxAttempts | FAIL(ATTEMPTS_EXHAUSTED) | 200 |
| otherwise | ACQUIRE_LEASE, then process | 200 or 503 |

There is no STALE_DISPATCH: a delivery with `seq < dispatch.seq` is a stale **wake-up** and is accepted safely. Older and newer tasks of one request are interchangeable; duplicates meet the lease (409) or the budget.

**Reconciler, `decideReconcile(doc, probe, now)`**. Query: `watchdogShard==s AND watchdogAt<=now`, limit 25 per shard, every 60 s. The probe is an optional load hint (adapters that skip it pass UNKNOWN).

| Step | Condition | Decision |
|---|---|---|
| 1 | terminal | clear watchdog |
| 2 | PROCESSING, lease valid | watchdog = leaseExp+30s |
| 3 | attempts ≥ maxAttempts | FAIL(ATTEMPTS_EXHAUSTED) (the only reconciler failure) |
| 4 | probe for current `seq` = EXISTS | WAIT_FOR_TASK: checks++, watchdog = now + min(2^checks min, 15 min). **No order**, so a backlog does not multiply tasks |
| 5 | probe = NOT_FOUND or UNKNOWN (incl. PERMISSION_DENIED) | DISPATCH: S9 (seq<maxSeq) or S10 attention (seq≥maxSeq). Commit seq++ then createTask |
| – | probe refers to an older seq | PROBE_STALE: ignore, no write |

**Processing failure vs dispatch failure.** *Processing* failure (S6, S7, S8) means business logic ran and was rejected or ran out of attempts (I5); it is the only way a request becomes FAILED. *Dispatch* trouble (no task observed, `createTask` errors, queue outage) never fails a request: the request stays non-terminal and durable, S10 marks it `attentionSince`, and orders continue. `DISPATCH_EXHAUSTED` is no longer produced. A `getTask` error such as PERMISSION_DENIED can no longer be "misread as absence" to harmful effect (ADR-011 amended): the worst case is an extra order and an extra task.

**Dispatch intervals.** Orders with `seq≤maxSeq` are prompt: watchdog +5 min (S9). Later orders are attention orders: at most one every **30 min** until a delivery clears `attentionSince` (S10). Without a lease in between, consecutive orders are ≥5 min apart, or ≥30 min apart in attention. A failed `createTask` creates no task, so an outage costs orders but not tasks; recovery takes at most one attention interval.

**Reconciler adapter flow (ADR-017, `packages/domain/src/reconcile.ts`).** Pure functions; the adapter only executes their decisions, each in a transaction on a fresh read. Crashing or stalling at any point is safe.

1. `decideReconcile(state, null, now)` on a plain read; unless it returns `PROBE_TASK`, re-run it in a transaction and commit its `write`.
2. `PROBE_TASK`: optionally `getTask(r-{id}-{seq})`, mapped to `EXISTS | NOT_FOUND | UNKNOWN` (every error except NOT_FOUND is UNKNOWN), then in a transaction `decideReconcile(fresh, probe, now)` and commit `write`.
3. `DISPATCH`: **order before create.** The step-2 commit already holds the new `seq`. Only then call `createTask` for `enqueue.seq` (retrying the same name within the pass is fine), then in a transaction `decideEnqueueResult(fresh, order, outcome, now)`, which only records `dispatch.lastError` (never status, seq, watchdog or budgets). Outcomes: CREATED, ALREADY_EXISTS (= CREATED), FAILED.

If `createTask` never runs or fails, the committed watchdog fires and the next pass places a new order. There are no claims, `VERIFY_TASK`, `decideVerifyResult`, RECREATE/REDISPATCH purposes or SHORT_RECHECK.

**Budget ceilings.** `processing.maxAttempts` is a stored absolute ceiling (I5). `dispatch.maxSeq` is the last *prompt* dispatch generation, not a ceiling: later orders are attention orders (S10). The MVP has one epoch: `maxAttempts = MAX_ATTEMPTS (5)`, `maxSeq = MAX_DISPATCH (3)`. Every "attempts ≥ MAX" and "seq ≥ maxSeq" check compares against these fields. Only S12 raises them. `attempts`, `seq`, `deliveredSeq` and `duplicateDeliveries` never decrease.

**S12 exceptions (P1 only).** S12 is the only exit from a terminal status. It applies to FAILED only; COMPLETED stays absorbing (I3). It also sets `maxAttempts`/`maxSeq` above their MVP values (I5 then holds per epoch). Neither exception is active in the MVP (no route, no admin role path); enabling them needs an ADR.

## 7. Invariants (must hold; changes require an ADR)

- **I1** A `202` response implies the request document is committed.
- **I2** At most one request per `(tenant, uid, key)` within the logical idempotency window.
- **I3** Terminal states are absorbing.
- **I4** Only the holder of the current `leaseId` can commit COMPLETED or FAILED from PROCESSING.
- **I5** Business logic starts at most `MAX_ATTEMPTS` times per request (counted in Firestore, not by queue headers).
- **I6** Triage output is a pure function of (request content, `rulesVersion`).
- **I7** Each task name `r-{id}-{seq}` has exactly one creator: `dispatch.seq` increments in a committed transaction before `createTask` for that seq. Correctness (I3–I5) never depends on task identity, `GetTask`, `ALREADY_EXISTS` or tombstones (ADR-017; replaces the absence-proof wording).

**Liveness.** Crashes and transient errors are recovered by Cloud Tasks retries plus lease takeover. Lost enqueues and exhausted tasks are recovered by the reconciler (new dispatch orders; attention orders every 30 min once prompt orders are spent). If the reconciler is down, those requests stay non-terminal but durable, and `stuck = count(watchdogAt < now-15m)` and the attention count (`attentionSince != null`) expose them.
**Non-claims:** exactly-once delivery, effectively-once external side effects, any bound on queue wait time.

## 8. Cloud Tasks

- Task name `r-{requestId}-{seq}`. Payload `{requestId, tenantId, seq, correlationId}`. OIDC uses `qp-tasks-invoker-sa`.
- Queue settings: `maxAttempts=10`, `maxRetryDuration=600s`, `minBackoff=2s`, `maxBackoff=60s`, `maxDoublings=4`, `maxDispatchesPerSecond=20`, `maxConcurrentDispatches=30`. Worker `dispatchDeadline=30s`.
- A task is deleted only when **both** maxAttempts **and** maxRetryDuration are exhausted. Queue retries are a safety net only; correctness relies on Firestore (I5).
- The `X-CloudTasks-TaskRetryCount` and `TaskExecutionCount` headers are per task and include infrastructure failures. They are logged only.
- A name stays deduplicated for about 1 h after deletion. `ALREADY_EXISTS` counts as CREATED for the order's unique creator and is never evidence about the queue (ADR-017).
- **Probe assumptions (C1/C2, B2) are optimisation-only.** `getTask` is a load hint for backpressure (EXISTS waits). If C1/C2 contradict it, the cost is extra orders and tasks, never wrong state; no decision depends on tombstone duration.
- Semantics are verified in the cloud spike (C1–C9, `docs/TASKS.md` B2). If the spike contradicts them, the fallback is to drop the probe and rely on the 5 m / 30 m order cadence (ADR-003, ADR-017).

## 9. Idempotency

- The `Idempotency-Key` header is required on POST (8–128 chars). Scope is `tenant + uid`. The fingerprint is sha256 of the canonical validated body.
- **Logical expiry.** `expiresAt = createdAt + 24h` is checked in code. Firestore TTL deletes asynchronously, so physical presence is irrelevant.
  - Before expiry: same fingerprint → replay (`202`, same `requestId`, `Idempotent-Replayed: true`). Different fingerprint → `409 IDEMPOTENCY_KEY_REUSED`.
  - After expiry: a transaction re-reads the record and, if it is still expired, overwrites it and creates a new request. Of two concurrent takeovers, one wins and the other sees a replay.
- TTL does not delete subcollections. `events` has its own TTL policy.

## 10. Ingestion admission control (ADR-012)

Bounds Firestore writes independently of Redis. Checks run in this order before any write:

1. **Global ceiling by construction:** API `maxInstances=5` × per-instance limits below.
2. **Per-instance token bucket** on POST: `QP_INGEST_RPS_PER_INSTANCE=40`. The accepted-POST ceiling is therefore 200/s, or about 600 writes/s, a configured ceiling and not a measured capacity.
3. **Per-instance in-flight commit semaphore:** `QP_INGEST_MAX_INFLIGHT=32`, with a 100 ms wait. When saturated → `503 OVERLOADED` + `Retry-After`.
4. **Backlog guard:** if `count(status==ACCEPTED)` (shared 5 s metrics value) exceeds `QP_MAX_BACKLOG=20000` → `503 BACKLOG_FULL`. If the metric is unavailable, the guard is skipped, because steps 2–3 still bound writes.
5. Bootstrap writes pass through the same semaphore and a per-uid/IP limiter.

The worker side is bounded by queue `maxDispatchesPerSecond` and `maxConcurrentDispatches`.

## 11. Authentication and membership (ADR-008, ADR-010)

- Google is the only sign-in provider. `verifyIdToken` (no revocation check) must report `email_verified` and `sign_in_provider=google.com`.
- The source of truth for tenant and role is `memberships/{uid}`. Custom claims are not used.
- `POST /api/v1/session/bootstrap` (idempotent) creates `{tenant: sandbox, role: member}` only when `tenants/sandbox.openSignup==true`. The role is a constant, never an input.
- Admin is granted **only** by `scripts/grant-role.mjs` (implemented as `.mjs` like the other repository scripts), run by the owner with their own `gcloud auth login` credentials (no key files). It is dry-run by default, needs `--apply` and an exact `--approve-project`, grants one uid in one existing active tenant, and refuses to move or reactivate memberships. The demo tenant is created by `scripts/seed-demo.mjs`. No API path elevates a role.
- No membership → `403 ONBOARDING_REQUIRED` (except `GET /me` and the bootstrap endpoint).
- **Cache consistency guarantee:**
  - Positive membership and tenant entries are cached per instance for at most `QP_MEMBERSHIP_CACHE_TTL=30s`.
  - Suspension, role downgrade, deletion and tenant kill switch take effect on every instance within **≤30 s**.
  - Negative lookups are never cached, so bootstrap takes effect immediately.
  - Admin-only operations always re-read the membership uncached, so revoking admin is immediate for privileged actions.
  - On a membership read failure the request fails closed (`503`). An expired entry is never served.
  - Disabling a Firebase user does not revoke already-issued ID tokens (≤1 h). **Membership suspension is the revocation mechanism.**
- Visibility: members see only their own requests. Admins see the whole tenant.

## 12. Redis (ADR-006, ADR-009)

Redis is used for exactly two things: limits and metrics cache. Business state never depends on it.

| Use | Normal | Redis unavailable (100 ms timeout, circuit opens for 30 s after 5 failures) |
|---|---|---|
| Burst rate limit (per user per minute) | Redis atomic counter | Per-instance memory limiter at `limit / maxInstances`. Logged as `ratelimit.degraded` |
| **Submission quotas** (per-user/day, tenant/day) where `quotaMode=enforced` | Redis counters | **Fail closed:** `503 QUOTA_UNAVAILABLE` + `Retry-After`. Never bypassed. `QP_QUOTA_FAILURE_MODE=open` is allowed only when `QP_ENV!=production`, which is checked at startup |
| Metrics cache (5 s, single-flight) | Redis | In-memory 5 s cache plus Firestore `count()` |

With `QP_REDIS_ENABLED=false` (benchmark "off" arm), only tenants with `quotaMode=none` (operator-provisioned `loadtest`) can submit. Open-signup tenants are rejected with `QUOTA_UNAVAILABLE`.

## 13. Indexes and hotspots

- Doc IDs are random (UUIDv4 or hash). Time-ordered IDs are forbidden.
- Single-field exemptions: `createdAt, updatedAt, startedAt, completedAt, watchdogAt, title, description, attributes, result, processing.*, dispatch.*`.
- Composite indexes: `(tenantId, createdBy, createdAt desc)`, `(tenantId, createdAt desc)`, `(watchdogShard, watchdogAt)`.
- Status counts use `count()` with index merging on `tenantId` and `status`.
- Known limitation: `(tenantId, createdAt)` is sequential within one tenant. Spike results report hotspot or 500/50/5 effects.
- Normal-path writes per request: 7 (3 API, 2 lease, 2 completion).

## 14. IAM (least privilege, ADR-011)

| Principal | Grants |
|---|---|
| `qp-api-sa` | `datastore.user`. On queue `qp-process`: `cloudtasks.tasks.create`. `iam.serviceAccountUser` on `qp-tasks-invoker-sa`. Secret accessor on `redis-url` |
| `qp-worker-sa` | `datastore.user`. On queue: custom role `qpReconciler` = `cloudtasks.tasks.create` + **`cloudtasks.tasks.get`**. `serviceAccountUser` on `qp-tasks-invoker-sa`. Secret accessor on `redis-url` |
| `qp-tasks-invoker-sa` | `run.invoker` on `qp-worker` |
| `qp-scheduler-sa` | `run.invoker` on `qp-worker` |
| `allUsers` | `run.invoker` on `qp-api` only (required by the Hosting rewrite; auth happens in the app) |

**B2 provisioning (ADR-016, `infra/`).** Offline-tested only; no cloud resource has been created or inspected, and C1–C9 are NOT RUN. Scripts are dry-run by default and run through `infra/apply.mjs` with explicit approvals: exact project ID, `--approve-firestore-location=europe-west1` (irreversible), and `--approve-b4-worker-image=<pinned digest>` before the main Scheduler job exists (spike jobs use a separate probe-image gate). IAM reads are resource-specific and merge policies (version 3, etags, conditions, audit config preserved). Existing active queues/jobs are paused on provisioning, verified by read-back; a failed pause is an error. Each `expiresAt` TTL is configured together with an empty single-field index exemption (`indexConfig,ttlConfig` update mask). Firestore index/field operations report PENDING until state reads show READY/ACTIVE. Activation and TTL deletion are separate owner-run verifications.

## 15. Config defaults

| Key | Default | Key | Default |
|---|---|---|---|
| API instances / concurrency | 0–5 / 80 | Worker instances / concurrency | 0–3 / 10 |
| API timeout | 15 s | Worker timeout | 60 s |
| Submit limits | 10/min/user, 30/day/user, 2000/day sandbox | Reconciler shards / limit per shard | 4 / 25 |
| Idempotency window | 24 h | Membership/tenant cache TTL | 30 s |

## 16. Failure test catalogue

P0: T1–T13. P1: T14–T16. The full table lives in `docs/TASKS.md` under B4.
All tests run against LocalDispatchQueue, which models tombstones, getTask, delete-on-2xx, the dual-condition deletion rule, rate and concurrency limits, pause/purge and fault injection, using a fake Clock.

## 17. Demo processing

Versioned triage rule table keyed by `type`. Inputs: `priority`, `safetyRisk`, `locationType`, `preferredWindow`. Outputs: `lane`, `slaTargetMinutes`, `team`, `score`.
A simulated slow "team capacity lookup" takes 200–800 ms, seeded by `hash(requestId)`, so the result is deterministic (I6).
