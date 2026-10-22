# Architecture Decision Records

Format: decision, why, alternatives, revisit when. Only Claude Code (integration owner) edits this file. Other agents propose ADRs in their PR description.
Status values: Accepted, Pending verification, Superseded.

### ADR-001 Modular monolith API plus independent worker
- **Decision:** Two Cloud Run services (`qp-api`, `qp-worker`) built from one monorepo with shared `packages/*`.
- **Why:** Ingestion and processing scale independently, and worker throughput stays capped by the queue.
- **Alternatives:** a single service; microservices.
- **Revisit when:** separate teams or release cycles appear. Status: Accepted (2026-10-19).

### ADR-002 Cloud Tasks over Pub/Sub
- **Decision:** One Cloud Tasks queue, `qp-process`, with an HTTP target and OIDC.
- **Why:** Per-queue dispatch rate and concurrency give backpressure without code, and the model is one task per request.
- **Alternatives:** Pub/Sub push, which has a native DLQ but no rate cap.
- **Revisit when:** fan-out to multiple consumers is needed (add Pub/Sub; do not replace Cloud Tasks). Status: Accepted.

### ADR-003 Correctness in Firestore; the reconciler redispatches only on proven absence
- **Decision:** `processing.attempts` is the budget. `dispatch.seq` increments only after `getTask` returns NOT_FOUND. A failed createTask is retried under the same name. Stored status has 4 values. A valid foreign lease gets `409`.
- **Why:** Fixes v0.1 defects H1–H7: generation loss, redispatch of backlog tasks, misuse of RetryCount, the dual-condition deletion rule, and slow crash recovery.
- **Amendment (ADR-017):** the "increments only after `getTask` returns NOT_FOUND" rule is replaced: `seq` increments in a committed order before `createTask`, and `getTask` is only a load hint. The Firestore-budget and 409 parts stand.
- **Alternatives:** time-based watchdog; task-first enqueue; separate outbox collection.
- **Revisit when:** C1/C2 spike results contradict getTask or tombstone behaviour. Fallback: a conservative time-based step 4. Status: Pending verification (C1–C5).

### ADR-004 Request document as outbox
- **Decision:** The request document plus `watchdogAt` and `watchdogShard` act as the outbox. Cloud Scheduler drives the reconciler every 60 s.
- **Why:** No extra collection or writes, no Cloud Functions trigger.
- **Alternatives:** an `outbox` collection with a relay.
- **Revisit when:** multiple side effects per request are introduced (webhooks). Status: Accepted.

### ADR-005 Logical idempotency expiry
- **Decision:** The 24 h window is enforced in code via `expiresAt`. An expired record is taken over in a transaction.
- **Why:** Firestore TTL deletion is asynchronous and has no guaranteed time.
- **Alternatives:** rely on TTL deletion.
- **Revisit when:** the window must be configurable per tenant. Status: Accepted.

### ADR-006 Redis is limited to rate limits, quotas and metrics cache
- **Decision:** Upstash Redis through ioredis. It is never a source of truth.
- **Why:** These are measurable problems: global limits across instances, and fewer Firestore reads for metrics polling.
- **Alternatives:** no Redis; Memorystore (needs a VPC and costs more).
- **Revisit when:** status-read caching shows a measured benefit. Status: Accepted.

### ADR-007 Region `europe-west1`, single region
- **Decision:** Firestore (regional), Cloud Run and Cloud Tasks all in `europe-west1`.
- **Why:** Lower cost, co-location of services, proximity to the owner.
- **Alternatives:** the `eur3` multi-region.
- **Revisit when:** an availability SLO requires multi-region. Status: Pending owner confirmation.

### ADR-008 Membership in Firestore; bootstrap grants member only
- **Decision:** `memberships/{uid}` is authoritative. Bootstrap writes the constant role `member`. Admin is granted only by an operator script.
- **Why:** Self-elevation is impossible, revocation is fast, and the API service account needs no Auth admin permission.
- **Alternatives:** custom claims.
- **Revisit when:** the per-request read cost matters at scale. Status: Accepted.

### ADR-009 (correction 2) Submission quotas fail closed
- **Decision:** When Redis is unavailable, `quotaMode=enforced` tenants get `503 QUOTA_UNAVAILABLE`. Burst rate limits alone degrade to per-instance memory limits. Fail-open is forbidden in production by a startup guard.
- **Why:** Per-instance memory counters reset whenever instances churn, which would silently bypass daily quotas on the public demo.
- **Alternatives:** a durable Firestore counter fallback (P2).
- **Revisit when:** Redis outages measurably hurt the demo. Status: Accepted (2026-10-19).

### ADR-010 (correction 3) Membership cache consistency
- **Decision:** Positive entries have a TTL of ≤30 s. Negatives are not cached. Admin-only operations read uncached. A read failure fails closed. Expired entries are never served.
- **Why:** Gives an explicit revocation bound (≤30 s, immediate for privileged actions). ID token revocation is not checked per request.
- **Alternatives:** no cache, which means one Firestore read per request; Redis pub/sub invalidation (P2).
- **Revisit when:** a stricter revocation SLO is needed. Status: Accepted.

### ADR-011 (correction 1) Reconciler IAM and probe errors (amended by ADR-017)
- **Decision:** `qp-worker-sa` gets a queue-scoped custom role with `cloudtasks.tasks.create` and `cloudtasks.tasks.get`. Any getTask error other than NOT_FOUND, including PERMISSION_DENIED, is `PROBE_UNKNOWN`: no state change, an ERROR log, and a retry in 1 min.
- **Why:** A missing permission must not be misread as task absence, which would trigger redispatch and burn `seq`.
- **Alternatives:** project-level `cloudtasks.viewer`, which is broader than needed.
- **Revisit when:** C9 shows that queue-level IAM is unsupported (then grant at project level). Status: Pending verification (C9).
- **Amendment (ADR-017):** `getTask` is now an optional load hint, not evidence. An error other than NOT_FOUND is still UNKNOWN, logged at ERROR and never terminal, but it is treated like NOT_FOUND for ordering: it may place a new dispatch order (cost: an extra, absorbed task). The "no state change, retry in 1 min" rule is replaced by the ordinary 5 m / 30 m order cadence. The IAM grant stays so the probe can reduce redundant orders.

### ADR-012 (correction 4) Ingestion admission control
- **Decision:** A per-instance token bucket (40/s), an in-flight commit semaphore (32), a backlog guard (20 000 ACCEPTED) and `maxInstances=5` bound ingestion writes without depending on Redis.
- **Why:** Prevents uncontrolled Firestore writes and cost during spikes or abuse.
- **Alternatives:** only per-user rate limits, which are unbounded across many users.
- **Revisit when:** load tests show the limits are too tight or too loose. Status: Accepted (values tunable).

### ADR-013 (correction 5) Single integration owner for shared state
- **Decision:** Claude Code is the only writer of `docs/TASKS.md`, `docs/PROJECT_STATE.md` and `docs/DECISIONS.md` and performs merges to `main`. Codex reports handoff notes, CCRs and ADR proposals in its PR description.
- **Why:** Avoids concurrent edits and drift in shared state.
- **Alternatives:** section-based multiple writers (v0.2), rejected.
- **Revisit when:** more than two agents work concurrently. Status: Accepted.

### ADR-014 (A2) Verified ALREADY_EXISTS and optimistic claim
- **Status: SUPERSEDED by ADR-017.** Kept for history.
- **Decision:** `ALREADY_EXISTS` from `createTask` is never proof of a tombstone. It yields `VERIFY_TASK`: re-probe the same `seq`, then `decideVerifyResult`. Only NOT_FOUND after it, under the still-current claim, proves absence (I7). The pre-`createTask` decision commits `watchdogAt = now+1min` as a claim; later decisions are NOOPs if the request is terminal, `seq` moved, the claim was lost or a lease is valid. A `REDISPATCH` generation that answers ALREADY_EXISTS then NOT_FOUND is a `RECHECK`, not proof. `seq` increments at most once per pass.
- **Why:** A claim fences Firestore writes, not queue side effects. A stalled claimant can create the task after a newer claimant probed NOT_FOUND; treating that ALREADY_EXISTS as a tombstone would redispatch a live task and burn `seq`.
- **Alternatives:** trust ALREADY_EXISTS as a tombstone (original step 6), rejected.
- **Revisit when:** C1/C2 contradict the queue assumptions (getTask visibility right after create; NOT_FOUND after completion). Status: Accepted; live verification pending.

### ADR-015 (A2) Retry budget ceilings and S12 exceptions
- **Decision:** `processing.maxAttempts` and `dispatch.maxSeq` are stored absolute ceilings (MVP: 5 and 3). S12 admin retry (P1) is the only exit from a terminal status (FAILED only) and the only writer that raises the ceilings: `maxAttempts = attempts + 5`, `maxSeq = seq + 3 - 1` after `seq++`. Counters never decrease.
- **Why:** Lets S12 grant a fresh budget without weakening I3/I5 for the MVP, where there is a single epoch.
- **Alternatives:** resetting counters on retry, rejected (loses history, breaks seq-scoped task names).
- **Revisit when:** S12 is enabled. That needs its own ADR on I3 and I5 (per epoch). Status: Accepted for the domain model; S12 itself is not active.

### ADR-016 (B2) Gated, offline-first infrastructure scripts
- **Decision:** `infra/` scripts are dry-run by default and need explicit approvals for project ID, the irreversible `europe-west1` Firestore location, and a pinned B4 worker image before the main Scheduler job is created. Provisioning pauses existing active queues/jobs and verifies it. TTL and single-field exemptions are configured together. Index/field operations report PENDING until read back.
- **Why:** Prevents accidental paid or irreversible actions and Scheduler runs against skeleton services.
- **Alternatives:** a single unattended apply, rejected.
- **Revisit when:** C1–C9 are run in the demo project. Status: Accepted; cloud behaviour NOT VERIFIED (C1–C9 pending, ADR-003/007/011).

### ADR-017 (A2.2) Dispatch is a wake-up, never a correctness signal
- **Decision:** A Cloud Tasks task only wakes a worker. Firestore alone decides execution (lease I4, attempt budget I5, terminal absorption I3). (1) Every dispatch order commits `seq++` and the watchdog before `createTask`, so each name `r-{id}-{seq}` has exactly one creator; `ALREADY_EXISTS` counts as CREATED. (2) The worker processes any delivery of a runnable request whatever its `seq` (no STALE_DISPATCH); `seq` greater than `dispatch.seq` is an anomaly (FUTURE_DISPATCH, no write). (3) No decision depends on `GetTask`, `ALREADY_EXISTS` or tombstones; `getTask` EXISTS only backs off (backpressure), NOT_FOUND/UNKNOWN places an order. (4) Dispatch never fails a request: S9 orders are prompt (+5 min, `seq<maxSeq`); S10 is an attention order (+30 min, `dispatch.attentionSince` set, request non-terminal) until a delivery clears it. `DISPATCH_EXHAUSTED` is no longer produced. (5) Removed: claims, `VERIFY_TASK`, `decideVerifyResult`, RECREATE/REDISPATCH purposes, SHORT_RECHECK. `decideEnqueueResult` only records `dispatch.lastError`.
- **Amends I7:** from "seq increments only after absence is proven" to "each task name has exactly one creator; correctness never depends on task identity".
- **Why:** A Firestore claim cannot fence Cloud Tasks side effects. Under ADR-014 a stalled claimant could create its task after a newer claimant had "proven" a tombstone, burning `seq` or, at `maxSeq`, failing a live request. Absence cannot be proven from outside the queue, so the design stops needing the proof.
- **Consequences:** Extra tasks are possible (outages, stalled creators, lying probes) and are absorbed at the cost of 409/200 responses. Order rate is bounded: ≥5 min apart, ≥30 min apart in attention. A queue outage costs orders, not tasks; recovery takes at most one attention interval. Exactly-once is still not claimed.
- **Alternatives:** keep ADR-014 and add queue-side fencing (not available in Cloud Tasks); trust tombstone duration (unverified).
- **Revisit when:** C1–C9 or B4 measurements show extra-task or attention rates that matter. Status: Accepted (owner approved 2026-10-19); verified by domain race (5040 interleavings) and fuzz suites; cloud behaviour NOT VERIFIED.

### ADR-018 (B5) Quota reservations are retained on uncertain acceptance commits
- **Decision:** An enforced-quota submission reserves its slot in Redis (atomic Lua: user + tenant counters and an operation receipt, one script) *inside* the Firestore acceptance transaction callback, reused across callback retries. The reservation is released only when the failure proves nothing was committed (domain/API errors, definite gRPC codes). After an ambiguous outcome (timeout, crash, unknown error) the slot is kept until the UTC day rollover. Replays and idempotency conflicts never touch Redis.
- **Why:** Redis and Firestore share no transaction. Releasing after an ambiguous commit could let a durably accepted request lose its slot (over-admission); keeping it can only under-admit.
- **Consequences:** Rare ambiguous failures can burn quota until midnight UTC. Redis failure on an enforced tenant is `503 QUOTA_UNAVAILABLE` (ADR-009), replays keep working.
- **Alternatives:** release on every failure (over-admits); a Firestore counter (P2, ADR-009).
- **Revisit when:** burnt-slot rates are measured against real Upstash. Status: Accepted (2026-10-20). Lua scripts verified only against a test double; **real Redis NOT RUN**.

### ADR-019 (B9) Free-tier deployment platform: Firebase Spark + Render free + Upstash QStash/Redis
- **Status:** Accepted (owner decisions 2026-10-20). Platform behaviour is measured only by a disposable spike (see Evidence). The QueuePilot adapters are not written or run yet.
- **Context:** The owner has no billing account or card, so the GCP path (Cloud Run, Cloud Tasks, Cloud Scheduler, Secret Manager, Cloud Storage; all need billing) is unavailable. The goal is an end-to-end deployment on free tiers only, for production experience.
- **Decision:**
  - Stack: Firebase Spark (Auth, Firestore in `europe-west1`, static Hosting) + two Render free web services (API and worker, built from the B7 Dockerfiles) + Upstash QStash (queue and scheduler) + a new Upstash Redis database named `queuepilot` (the spike database is not reused).
  - API and worker stay separate services (ADR-001). The worker runs as an HTTP web service receiving QStash pushes, because the Render background worker type is not free.
  - New `QStashQueue` adapter behind `QueuePort` / the `DispatchQueue` factory. Firestore stays the source of truth. `probe()` is a constant `UNKNOWN`, which ADR-011/014/017 already allow (UNKNOWN places an order). ADR-017 behaviour (dispatch is a wake-up, `seq`, attention orders, lease I4, attempt budget I5, terminal absorption I3) is unchanged. A QStash publish answered 201, including `deduplicated:true`, counts as CREATED, like `ALREADY_EXISTS`.
  - The Cloud Tasks adapter stays supported and selectable by configuration (paid GCP path).
  - Scheduler: a QStash schedule ticks the reconciler every 60 minutes, plus a throttled opportunistic reconcile on incoming requests. Liveness after a lost wake-up is bounded by roughly one tick (or the next request), not by seconds.
  - Sandbox quota 300 per day, `openSignup=false`. Redis rate limiting and quotas are unchanged (ADR-009, ADR-018).
  - Free-quota safety: fail closed; `RESOURCE_EXHAUSTED` is classified, not treated as a generic retryable error; QStash retries limited to 2-3; the worker returns `Retry-After` on 409 and 503; the dashboard polls every 30 s; stuck counts use `count()` aggregations.
- **Evidence** (measured 2026-10-20 in a disposable spike, repo `nevzatius/render-qstash-spike`, commit `402c284`; the spike service is deleted; none of this is a QueuePilot measurement):
  - QStash publish returns 201. A duplicate deduplication id also returns **201** (not 202) with `"deduplicated":true` in the body, and only one delivery happens (n=1). The adapter must read the `deduplicated` field and treat both as CREATED.
  - Every delivery and every retry counts as a message: the MESSAGES counter went 8 -> 14 for `Upstash-Retries: 5`, which produced 6 deliveries (n=1). The free limit is 1,000 messages per day. **Whether retries count toward the daily limit was not directly verified.**
  - Default retry backoff observed about 12 s, then about 154 s (n=1 run). `Retry-After` is honoured (30 s and 5 s tested, within about 1 s; n=1 each). `Upstash-Retries: 5` is accepted on the free plan.
  - Default HTTP timeout is 15 min. `Upstash-Timeout` needs a Go duration with a unit (`10s`; plain `10` gives 400). It is applied: a 20 s handler with `Upstash-Timeout: 10s` was aborted at 9965 ms (n=1). The server kept running and logged 200, so worker lease/idempotency must tolerate work that finishes after QStash gave up.
  - Render free services sleep after 15 min idle. Direct request to a sleeping service: HTTP 200 JSON, no interstitial, total 13.7 s, process uptime 7.6 s (n=1; Render docs say up to about 50 s, so keep margin). QStash publish to a sleeping service: delivered on the first attempt, `retried=0`, uptime 8.3 s (n=1).
  - Render proxy chain: a clean request has `X-Forwarded-For` = `<client-ip>, <cloudflare-ip 172.x>, <render-internal 10.x>` and socket address 127.0.0.1 (n=1). Render does **not** strip a spoofed `X-Forwarded-For`: the spoofed value is prepended and the real client follows it (n=1). Counting the socket as hop 0, the real client is the 4th address from the right, so Fastify `trustProxy` must be the number **3** (never `true`), exposed as env `TRUST_PROXY_HOPS`. Re-verify with a spoofed-header test in B9-4 and re-measure if the platform changes. No real IP address belongs in the repo; use `<client-ip>`.
  - Upstash Redis free: 500k commands/month, 250 MB. Cold TCP connect about 404 ms, warm 24-40 ms, commands about 2 ms (small sample). QueuePilot's 100 ms Redis connect timeout is too tight for cold starts: raise it or pre-warm.
  - Firebase Spark: 50K reads and 20K writes per day; exceeding a quota shuts the product off. Cloud Storage, Cloud Run, Cloud Tasks, Cloud Scheduler and Secret Manager need billing, so they are out. (Published limits, not measured.)
  - Render free: 750 instance hours per month per workspace, ephemeral filesystem; the background worker type is not free. (Published limits, not measured.)
- **Alternatives considered:**
  - Option B, Firestore outbox polled by a scheduler: rejected. Liveness would equal the tick interval and every poll spends the 50K daily read budget.
  - Option C, direct signed HTTP wake of the worker plus a Firestore outbox: fallback only, built only if delivery to a sleeping service breaks in production.
  - Paid GCP: unavailable (no billing account); stays supported behind the factory.
- **Consequences:**
  - Cold starts add roughly 8-14 s (up to about 50 s by Render docs) to the first request and to wake-ups; the UI needs a "service waking up" state.
  - Delivery stays at-least-once, plus work that finishes after QStash timed out. Exactly-once and throughput are not claimed.
  - Daily budgets (1,000 QStash messages, 50K reads, 20K writes, 500k Redis commands per month, 750 instance hours) cap the demo, hence quota 300 and fail-closed behaviour.
  - Free-tier terms can change; this is a showcase, not a production claim.
- **Rollback / shutdown:** Delete the QStash schedule and queue (B9-7 script), suspend or delete both Render services, delete the Upstash `queuepilot` database, disable Firebase Hosting. Firestore data is synthetic and can be deleted; the Firestore location cannot be changed after creation. Switching back to Cloud Tasks is a configuration change through the adapter factory once billing exists.
- **Work packages:**
  - B9-1 Config, production guard, adapter factory. Accept: queue backend selectable by env, production guard rejects unsafe or missing config, existing tests green.
  - B9-2 `QStashQueue` adapter and `LocalDispatchQueue` QStash profile. Accept: reads `deduplicated`, sets `Upstash-Retries` and `Upstash-Timeout` with a unit, 201 and deduplicated both map to CREATED, table-driven tests.
  - B9-3 Worker QStash signature verifier, `Retry-After` on 409/503. Accept: bad or missing signature rejected, current and next signing keys accepted, completion after a QStash timeout stays safe.
  - B9-4 CORS allowlist and trustProxy/IP decision. Accept: `TRUST_PROXY_HOPS` env, spoofing test shows the client IP cannot be forged.
  - B9-5 Firestore read budget. Accept: stuck count via `count()`, throttled opportunistic reconcile, `RESOURCE_EXHAUSTED` classified, Redis connect timeout raised or pre-warmed.
  - B9-6 Web. Accept: cross-origin API base URL, 30 s polling, "service waking up" UX.
  - B9-7 Deployment files and scripts. Accept: `render.yaml`, `firebase.json`, QStash setup and shutdown scripts, preflight free profile, `seed-demo` limit parameter; dry-run by default (ADR-016).
  - B9-8 Runbook and `PROJECT_STATE.md`. Accept: the owner can follow the free-tier path step by step.
  - B9-9 Owner manual setup and live verification. Accept: one request reaches COMPLETED on the live stack; Evidence items re-measured against QueuePilot.
- **Re-measure when:** Render changes the proxy chain or sleep behaviour; QStash or Upstash change free limits or retry/deduplication semantics; whether retries count toward the daily limit gets verified; sleeping-service delivery fails in production (then Option C); the first real QueuePilot cold-start and message-count numbers exist (B9-9).
- **Revisit when:** billing becomes available. Status: Accepted; platform behaviour NOT VERIFIED for QueuePilot until B9-9.
- **Amendment 2026-10-22 (B9-7; the text above is history and is left as written):**
  - `trustProxy` is a hop *function*, not the number 3. Fastify 5.12.7 treats a numeric `trustProxy` as "trust nobody" (verified with a scratch script in B9-4), so "must be the number **3**" above does not work as written. The API builds a function from the validated integer `TRUST_PROXY_HOPS` (trust `hop < hops`, never `true`), and honours `X-Forwarded-For` only when the socket peer is private, loopback or link-local and at least `hops` entries exist; otherwise `request.ip` is the socket address. The intent is unchanged (trust exactly the 3 hops Render appends, counting the socket as hop 0). The client IP is safe only while the platform appends exactly `TRUST_PROXY_HOPS` entries, so the live spoofed-header test (B9-9) is mandatory. `render.yaml` sets `TRUST_PROXY_HOPS=3` for the API.
  - The Redis connect timeout is no longer 100 ms. It is configurable (`QP_REDIS_CONNECT_TIMEOUT_MS`, 100 to 3000, default 1500 ms, about 3.7 times the cold connect measured in the spike) with a background pre-warm; the per-command timeout stays 100 ms. Worst Redis-down request: rate limiter plus quota, 2 x (1500 + 100) = 3.2 s.
  - Credentials outside Google Cloud (B9-7): Render has no ambient identity, so Firestore needs an explicit service-account key. `QP_FIREBASE_SERVICE_ACCOUNT_JSON` carries it as one secret, validated at startup with constant messages, opt-in, refused next to an emulator or a demo project, and used in one place (`createFirebaseApp`). The key is a long-lived credential with broad Firebase Admin access: delete it at shutdown. ID-token verification needs only the project id. Cloud Run keeps using its metadata identity.
  - Files: `render.yaml`, `firebase.json`/`.firebaserc` (placeholder project id), `scripts/qstash-setup.mjs`, `scripts/qstash-shutdown.mjs`, `preflight.mjs --profile free`, `seed-demo.mjs --profile free --tenant-daily-limit`. Runbook: `docs/DEPLOYMENT_RUNBOOK.md`, "Free-tier path". Nothing was run against Render, Firebase or Upstash.
