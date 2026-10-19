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

### ADR-011 (correction 1) Reconciler IAM and probe errors
- **Decision:** `qp-worker-sa` gets a queue-scoped custom role with `cloudtasks.tasks.create` and `cloudtasks.tasks.get`. Any getTask error other than NOT_FOUND, including PERMISSION_DENIED, is `PROBE_UNKNOWN`: no state change, an ERROR log, and a retry in 1 min.
- **Why:** A missing permission must not be misread as task absence, which would trigger redispatch and burn `seq`.
- **Alternatives:** project-level `cloudtasks.viewer`, which is broader than needed.
- **Revisit when:** C9 shows that queue-level IAM is unsupported (then grant at project level). Status: Pending verification (C9).

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
