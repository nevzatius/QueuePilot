# Tasks and Working Agreement

Single writer: Claude Code, the integration owner (ADR-013). Other agents report through PR descriptions.

## Working agreement

- **Branches:** one work package (WP) per branch, named `claude/<wp>-<slug>` or `codex/<wp>-<slug>`. At most **two active development branches** exist at once, one per agent.
- **Ownership:** an agent edits only paths it owns (table below). Anything else is requested through a CCR in the PR description.
- **Before a merge request:** rebase on `main`. `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass, plus integration tests where the WP touches IO. Fill in `.github/PULL_REQUEST_TEMPLATE.md`.
- **Integration:** Claude Code reviews (with a specialist agent if relevant), squash-merges to `main`, then updates this file and `PROJECT_STATE.md` in the same integration commit.
- **Owner approval required for:** milestone gates, IAM or infra changes, anything that costs money, and every deploy. Agents never deploy, push, use credentials or install global tools without explicit approval.
- **Language:** source code and technical docs in English. Progress reports to the owner in Turkish.
- **Contract change request (CCR):** state the problem, the proposed schema diff and the affected WPs. Claude applies it in `packages/contracts` or `packages/domain`.

## Ownership

| Owner | Paths |
|---|---|
| Claude Code | `packages/contracts/**`, `packages/domain/**`, `apps/web/**`, `docs/**`, `CLAUDE.md`, `.claude/**`, `.github/PULL_REQUEST_TEMPLATE.md` |
| Codex | `packages/core/**`, `apps/api/**`, `apps/worker/**`, `tests/**`, `infra/**`, `scripts/**`, `.github/workflows/**`, root tooling (`package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, eslint/prettier/vitest configs), `AGENTS.md`, `firebase.json`, `.env.example`, `README.md`, `README.tr.md` (Claude reviews) |

## Work packages

Status values: `todo | active | review | done | blocked`.

| WP | Owner | Depends on | Status |
|---|---|---|---|
| A0 Agent bootstrap | Claude | – | done (2026-10-19) |
| A1 Contracts | Claude | A0 | done (merged `d45ed59`) |
| A2 Domain | Claude | A1 | done (A2.2 / ADR-017 integrated 2026-10-19; supersedes the A2.1 verify flow) |
| A3 Web | Claude | A1 (mock API until B3) | merged 2026-10-19 (`593e39b`) |
| A4 Reviews and integration | Claude | – | continuous |
| B1 Foundation and CI | Codex | A0 | done (merged `c7c6e00`) |
| B2 Cloud spike and infra scripts | Codex (scripts) + owner (runs) | B1 | scripts merged (2026-10-19); **C1–C9 NOT RUN**, owner gate open |
| B3 Platform, auth and ingestion | Codex | A1, A2, B1 | merged 2026-10-19 (`b6612bc`); emulator suite re-run on merged tree 2026-10-20: pass |
| B4 Queue, worker and reconciler | Codex | A2, B3 | merged 2026-10-20 (`3b07080`); T1–T13 + races on emulator pass; cloud NOT RUN |
| B5 Redis limits, quotas and cache | Codex | B3 | merged 2026-10-20 (`9bc5949`); real-Redis suites **PASS in GitHub Actions** (run 39410411597 and later); not run locally (no Redis on the dev machine) |
| B6 Load tests and verify | Codex | B4, B5, B2 | local Node suite done 2026-10-20 (`tests/load`, 3 reps); **k6 and real-Redis variants NOT RUN** |
| B7 Deploy finalisation and README drafts | Codex (Claude implemented on the owner's instruction) | all | **pre-deployment hardening on `claude/b7-predeploy-hardening` (superset of `claude/b7-preflight`), not merged:** Dockerfiles + CI image job, `scripts/{preflight,deploy,shutdown,seed-demo,grant-role}.mjs` with unit and emulator tests; **nothing deployed, C1–C9 NOT RUN, the scripts never ran against a real project** |

### A1 Contracts: `packages/contracts`
- Zod schemas for the request create body, request DTO, list/page, metrics, `me`, bootstrap, the Problem Details envelope, error codes, `TaskPayload` and the status enum with derived views.
- **Accept:** type-checks. Used unchanged by A3, B3 and B4. Cross-review: Codex.

### A2 Domain: `packages/domain`
- `decideDelivery`, `decideReconcile`, `decideEnqueueResult`, `decideVerifyResult` (ARCHITECTURE §6), idempotency expiry, canonical fingerprint, versioned triage rules (§17).
- **Delivered (ADR-017):** `decideDelivery`, `decideReconcile`, `decideEnqueueResult` (`decideVerifyResult`, claims and `VERIFY_TASK` are gone). B4 adapters follow the §6 "Reconciler adapter flow" and read budgets from `processing.maxAttempts` / `dispatch.maxSeq`.
- **Accept:** one table-driven test for each row of S1–S12 and both decision tables. No IO imports. Cross-review: Codex.

### A3 Web: `apps/web`
- Google login, then bootstrap, then submit form (key reused on retry), my-requests list (5 s polling), detail with triage result and timeline, metric cards. No charts.
- **Accept:** works against the local API. `ONBOARDING_REQUIRED` and `QUOTA_UNAVAILABLE` states are handled.

### B1 Foundation: root tooling and `.github/workflows/ci.yml`
- pnpm workspaces, TS project refs, ESLint import-boundary rules (ARCHITECTURE §3), Vitest, Firebase emulator config.
- CI job: install, lint, typecheck, unit tests, integration tests (setup-java, emulator, `services: redis`), build.
- **Accept:** CI is green on an empty skeleton. `pnpm` scripts exist at the root.

### B2 Cloud spike: `infra/`, `scripts/spike/`
- Idempotent gcloud scripts covering APIs, service accounts, IAM (ARCHITECTURE §14), the queue, the scheduler, Firestore indexes, TTL policies and rules, and the Hosting rewrite.
- Run the C1–C9 checks and record the results for the ADRs:
  - **C1** getTask on a completed task returns NOT_FOUND.
  - **C2** createTask with an existing or deleted name returns ALREADY_EXISTS (tombstone duration).
  - **C3** task headers.
  - **C4** the dual-condition deletion rule with `maxAttempts=3` and `maxRetryDuration=120s`.
  - **C5** 409 backoff and Cloud Run 429 behaviour.
  - **C6** OIDC: the worker returns 403 without a token, and Tasks and Scheduler get 200.
  - **C7** Hosting forwards the `Authorization` header.
  - **C8** Upstash PING p50/p95 from Cloud Run.
  - **C9** queue-scoped `tasks.get` works, and removing it yields PERMISSION_DENIED, which the probe maps to PROBE_UNKNOWN.
- **Accept:** re-running the scripts is a no-op. Results are posted in the PR for ADR-003, ADR-011 and ADR-007.

### B3 Platform, auth and ingestion: `packages/core/{config,log,auth,membership,idempotency,requests,admission,metrics}`, `apps/api`, `scripts/grant-role.mjs` (implemented in B7 as `.mjs`)
- **Accept:**
  - Idempotency replay, `409` and the logical-expiry takeover are tested.
  - Bootstrap can never yield admin (test).
  - Cross-tenant and cross-user reads return 404.
  - The membership cache follows ADR-010 (tested with a fake Clock).
  - Admission returns 503 at its limits (ADR-012).
- Cross-review: Claude with security-reviewer.

### B4 Queue, worker and reconciler: `packages/core/{queue,processing,reconciler}`, `apps/worker`
- CloudTasks adapter, LocalDispatchQueue (ARCHITECTURE §16), execution of the domain decisions inside guarded transactions.
- **Accept:** T1–T13 pass. Cross-review: Claude with architecture-reviewer.

| ID | Scenario → expected result |
|---|---|
| T1 | API createTask fails → reconciler recreates the same seq → COMPLETED, seq=1 |
| T2 | Ambiguous createTask → probe EXISTS → wait. One completion, seq=1 |
| T3 | Queue paused for 30 min (fake time) with 500 tasks → no seq++; all COMPLETED after resume |
| T4 | Pre-lease infrastructure failures exhaust the task → NOT_FOUND, deliveredSeq=0, tombstone → seq=2, attempts=0 |
| T5 | Crash after lease → 409 until the lease expires → takeover. attempts=2, one COMPLETED |
| T6 | Crash after the completion commit → retry gets 200, duplicateDeliveries=1 |
| T7 | Transient failure on the last attempt → FAILED(ATTEMPTS_EXHAUSTED) |
| T8 | Two concurrent deliveries → one lease, the other gets 409. One COMPLETED |
| T9 | Stale seq delivery → 200, no processing |
| T10 | Lease lost mid-processing → the late completion is fenced out |
| T11 | Two concurrent reconcilers → seq increments at most once per proven loss |
| T12 | Reconciler off and createTask failed → stays ACCEPTED, stuck=1, recovered once the reconciler runs |
| T13 | Permanent error → FAILED, attempts=1 |
| T14–T16 (P1) | Crash on the final attempt; replay heal; purge until DISPATCH_EXHAUSTED |

Row changes under ADR-017: **T4** now ends in a new dispatch order (seq=2) with no tombstone proof; **T9** is a stale-seq delivery that is *accepted* and processed safely (no STALE_DISPATCH), not dropped; **T14–T16** no longer end in DISPATCH_EXHAUSTED but in attention (S10).

**B4 adapter integration contract (ADR-017).**
- *Reconciler order-before-create:* (1) plain read + `decideReconcile(state, null, now)`; (2) optional `getTask` mapped to EXISTS | NOT_FOUND | UNKNOWN, then `decideReconcile(fresh, probe, now)` in a transaction; (3) on DISPATCH the commit (seq++, watchdog) happens **before** `createTask(enqueue.seq)`; then `decideEnqueueResult` records `dispatch.lastError` only. ALREADY_EXISTS is CREATED. Never branch on GetTask, ALREADY_EXISTS or tombstones. No claims or VERIFY_TASK.
- *Worker lease and fencing:* run `decideDelivery` in a transaction on a fresh read; acquire the lease (new random `leaseId`) before any business logic; accept deliveries of any `seq ≤ dispatch.seq`; log FUTURE_DISPATCH at ERROR; 409 on a valid foreign lease; complete/fail only via `decideCompletion` fenced by `leaseId` (I4); count attempts in Firestore (I5), never from queue headers.
- *Required race regression coverage (B4, against LocalDispatchQueue with fake Clock):* stalled creator creates late after a newer order (no burned seq, no FAILED at seq=maxSeq); two concurrent reconcilers (at most one seq++ per due watchdog); duplicate and stale-seq deliveries with one COMPLETED; delayed createTask after completion (absorbed as DUPLICATE_SUPPRESSED); createTask failure and queue outage (attention, never FAILED, order rate ≥5 m / ≥30 m); lying probe (EXISTS/NOT_FOUND/UNKNOWN incl. PERMISSION_DENIED); crash between order commit and createTask. Mirror the domain race (5040 interleavings) and fuzz (800 schedules) suites, which stay in `packages/domain/test`.
- *Scope:* S12 admin retry stays **outside the MVP** (needs its own ADR, ADR-015).
- Additional B4 test: a getTask PERMISSION_DENIED never fails a request and at worst yields an extra order (ADR-011 amended).

### B5 Redis: `packages/core/{ratelimit,quota,cache}`
- **Accept:**
  - Redis down → quotas fail closed (`503 QUOTA_UNAVAILABLE`) and burst limits degrade (ADR-009).
  - The production startup guard rejects fail-open.
  - With two instances, the global limit holds with Redis on and is exceeded with Redis off (measured).

### B6 Load: `tests/load`
- k6 baseline and spike (arrival-rate), Redis on/off (metrics polling reads and p95; rate-limit correctness), `verify.ts`, backlog sampler, results JSON.
- **Accept:** `verify.ts` reports lost=0 and ≤1 completion per request. Each result records environment, commit, config and 3 repetitions.

### B7 Deploy finalisation: `infra/`, `scripts/`
- Deploy and shutdown scripts, budget alert setup, README EN/TR drafts.
- **Accept:** a fresh-project run is reproducible, the shutdown script has been tried once, and the README contains measured numbers only.

**B2 merge notes.** Offline: `node --test infra/offline.test.mjs infra/targeted.test.mjs` = 31 pass. Cloud-run steps need the owner and the approvals listed in `infra/README.md`. B2 does not create the main Scheduler job until the B4 worker image is approved. Note: `infra/` tests are not wired into `pnpm test` or CI (follow-up for Codex, B3 prelude).

**B7 pre-deployment hardening notes (branch `claude/b7-preflight`).** Added: `apps/api/Dockerfile`, `apps/worker/Dockerfile`, `.dockerignore`, CI job `docker-images`
(build + `scripts/docker-smoke.mjs`, no push), `scripts/lib/{ops,cloud-ops,preflight}.mjs`, `scripts/{preflight,deploy,shutdown,seed-demo,grant-role}.mjs`,
`scripts/scripts.test.mjs` (21 offline tests, wired into `pnpm test`), `tests/integration/owner-scripts.test.ts` (3 emulator tests, CLI exit codes). `infra/cloud.mjs` only gained an
`export` on `ensurePaused`. Accept still open: "a fresh-project run is reproducible, the shutdown script has been tried once" (owner, needs a real demo project).

**B7 hardening follow-up (branch `claude/b7-predeploy-hardening`, 2026-10-20 session 4).** Built on `claude/b7-preflight` (another Claude session, commits
`a40e2e1`, `9396642`) after the owner chose to build on it. Gaps closed against the owner's B7 checklist: `grant-role` resolves `--uid`/`--email` through Identity Toolkit
`accounts:lookup` and requires one enabled, verified, Google-provider account, a read-only dry run and `--approve-uid`; `seed-demo` creates the tenant only and reports DRIFT;
`preflight --run` is GET-only cloud comparison; `shutdown --revoke-public-api`; data scripts require `--project-number` for cloud writes; runtime image files are root-owned;
`docker-smoke` uses production-shaped settings (`scripts/lib/smoke-env.mjs`, schema-checked by `tests/unit/smoke-env.test.ts`) and checks guards, worker 403, file set and
read-only files. Security review (security-reviewer, read-only): no real findings; four low-severity hardening items applied, two noted (apply.mjs `iam` stage has no
public-API gate of its own, pre-existing; `corepack enable` fetches the pnpm version named in `packageManager` without a hash pin). Accept still open: fresh-project run and
one real shutdown (owner, needs a demo project).

## B9 follow-ups (PR #3 review, `claude/b9-1-config-factory`)

- **Deferred F6:** in production reject loopback, private and link-local worker URL hosts for both backends. Blocked: the smoke-env scripts use localhost, so adapt them first.
- **B9-3 DONE on `claude/b9-3-qstash-verifier`** (this section's F3 item and ADR-019 B9-3 acceptance): `qstash` auth mode and config matrix, `QStashCallerVerifier` (HS256, current/next key, iss/sub/exp/nbf/body), raw body kept for the two internal routes, 401 with value-free reason codes, `Retry-After` on 409 (60 s) and 503 (300 s). Unit and route tests only: no real QStash token has been checked. Original item: **B9-3 must (F3, section 7):** add a `qstash` value to `QP_WORKER_AUTH_MODE`; production requires the mode matching the adapter (cloud -> oidc, qstash -> qstash) and rejects mismatches; branch `createCallerVerifier` to a QStash signature verifier that accepts both signing keys for both the tasks and scheduler callers (the reconciler tick also comes from QStash); keep the verifier-before-SDK-clients order and the local-auth check; add a test that `loadConfig(PROD_QSTASH)` followed by `createCallerVerifier` raises no OIDC error.
- **B9-9 live checks for the QStash verifier** (none of this has been run; all tests sign tokens with a fake key):
  1. A real QStash delivery to `/internal/tasks` verifies with the real signing keys (answers 200, not 401); same for a schedule tick on `/internal/reconcile`. Confirm the JWT really is HS256 with claims `iss=Upstash`, `sub`, `exp`, `body` (and whether `nbf` is present), and that the `body` claim is the unpadded base64url SHA-256 of an empty body when the tick has none.
  2. Key rotation current -> next works: rotate in the Upstash console, keep the old value as current/new as next, deliveries still verify before and after.
  3. The `sub` matches behind Render's proxy: the expected value is `QP_WORKER_URL` + path, so `QP_WORKER_URL` must be the public `https://...onrender.com` origin QStash was given. Log `CALLER_REJECTED` reason codes if any delivery fails.
  4. QStash honours `Retry-After` 60 s (409) and 300 s (503) from QueuePilot's worker, and what it does with a 300 s value (any maximum), and whether `Upstash-Retried` should be logged.
  5. Clock tolerance (30 s) is enough against real QStash timestamps (check `iat`/`exp` skew in a delivery).
- **B9-4 DONE on `claude/b9-4-cors-proxy-redis`** (ADR-019 B9-4 acceptance; hop-count decision made, no separate T1 item existed in this file): `QP_CORS_ORIGINS` allow-list (API only, exact https origins, localhost only outside production, no wildcard, `Vary: Origin`, credentials never allowed, preflight answered before auth), `TRUST_PROXY_HOPS` (0 to 5, default 0; **Render = 3**), and `QP_REDIS_CONNECT_TIMEOUT_MS` (100 to 3000, default 1500) with a background pre-warm. Decisions to carry forward:
  - Fastify 5.12 maps a *numeric* `trustProxy` to "trust nobody" (`lib/request.js`), so ADR-019's "pass the number 3" does not work as written; the API passes a function built from the validated integer (`hop < hops`), never `true`. Also required: a private/loopback/link-local socket peer and at least `hops` `X-Forwarded-For` entries, else `request.ip` is the socket address. ADR-019 text is untouched; amend it at integration (the intent, trust exactly 3 hops, is unchanged).
  - The Redis connect and command budgets are now separate (connect 1500 ms, command 100 ms). ARCHITECTURE section 12 still says "100 ms timeout"; update it at integration. Worst Redis-down request: rate limiter + quota, 2 x (1500 + 100) = 3.2 s, inside the 15 s API timeout; the circuit (5 failures, 30 s) is unchanged, fail-closed is unchanged. The Redis connect-timeout part of B9-5 is done here; the rest of B9-5 is open.
  - Tests are unit/route level (fake Redis connect, Fastify inject). Nothing was run against Render, Firebase Hosting or Upstash.
- **B9-9 live checks for B9-4** (none of this has been run):
  1. Real browser preflight from the Firebase Hosting origin: `OPTIONS /api/v1/requests` answers 204 with that exact origin, `Authorization, Content-Type, Idempotency-Key`, no credentials; then a real `POST` with the bearer token succeeds and the page can read `Retry-After` and `Idempotent-Replayed`. Set `QP_CORS_ORIGINS` to the hosting origin(s) first (both `*.web.app` and `*.firebaseapp.com` if both are used). A request from another origin must show no `Access-Control-Allow-Origin`.
  2. Live spoofed `X-Forwarded-For` against the Render URL: send `X-Forwarded-For: <forged>` (and several forged entries) and prove the logged/limited client IP is the real one, not the forged one, e.g. by hitting the bootstrap IP limiter (30/min per IP) from two networks. Re-measure the chain (`<spoofed>, <client>, <cloudflare 172.x>, <render 10.x>`, socket loopback) and confirm 3 is still right; if the socket peer is not loopback/private the header is ignored (safe, but every client then shares one bucket).
  3. Cold-start Redis time on the live stack: first request after the API wakes (pre-warm on, pre-warm off), time to connect to Upstash from Render, and whether 1500 ms still has margin; log `ratelimit.degraded` and `QUOTA_UNAVAILABLE` rates during a cold start.
- **B9-4 review follow-ups (PR #6):**
  - N2 (accepted): a malformed URL such as `OPTIONS /%zz` is answered by Fastify before `onRequest`, so it carries no CORS headers; preflight replies lack `x-correlation-id` and `cache-control: no-store`, because the CORS hook ends them before the header hook.
  - N3 for **B9-7** (DONE in B9-7, see the B9-7 item below): `render.yaml` must set `TRUST_PROXY_HOPS=3` and `QP_CORS_ORIGINS`; add a preflight warning when the queue adapter is `qstash` and `TRUST_PROXY_HOPS` is 0 (every client then shares the socket address in the bootstrap IP limiter).
  - F5 stays a B9-9 live item: Upstash cold AUTH and the ready check run under the 100 ms command timeout. ioredis `connectTimeout` stops at connect/secureConnect, so AUTH and INFO get the command timeout, not the connect timeout. If that fails live, consider `enableReadyCheck: false` or a larger handshake budget.
  - Integration-time corrections (APPLIED in B9-7: ADR-019 amendment dated 2026-10-22 and ARCHITECTURE section 12): **ADR-019** and **ARCHITECTURE.md section 12** must say that `trustProxy` is a hop *function* (a numeric value is treated as "trust nobody" by Fastify 5.12.7, verified with a scratch script) and that the Redis connect timeout is no longer 100 ms (connect 1500 ms default, command 100 ms). The client IP is safe only while the platform appends exactly `TRUST_PROXY_HOPS` entries; the live spoofed-header test (B9-9 item 2) is mandatory.
- **B9-6 DONE on `claude/b9-6-web-cross-origin`** (web only): build-time `VITE_API_BASE_URL` (a bad production value shows a startup configuration error, it does not fail the build, because CI builds without it), `credentials: 'omit'`, cold-start notice and bounded retry (`apps/web/src/api/coldStart.ts`), poll interval 5 s -> 30 s (hidden-tab pause already existed), dev proxy for `/api` added to `vite.config.ts` (`VITE_DEV_API_PROXY` was documented but unused). Unit tests only.
- **B9-9 live checks for B9-6** (none of this has been run):
  1. A real browser on the Firebase Hosting origin signs in and calls the Render API: preflight passes, calls succeed, `Idempotent-Replayed` is readable on a replayed `POST`.
  2. Cold-start banner against a really sleeping Render service (idle 15+ min): the notice appears, the call finishes without a visible error, and the notice disappears. Record the real wake time against the 4 s / 90 s constants in `coldStart.ts`.
  3. What a sleeping Render service really answers to a cross-origin call: if it is a proxy 502/503 without CORS headers the browser reports a network error (handled the same way); confirm no case falls through as a final error before 90 s.
  4. A `POST` interrupted by a wake-up is retried with the same key and creates exactly one request.
- **B9-5 must (PR #5 review F2):** the opportunistic reconcile throttle must be time-based and must also cover `/internal/reconcile`. A captured valid token plus its body can be replayed until `exp` + 30 s (the clock tolerance); each replay on the tasks route costs a transaction read and an S11 write, on the reconcile route a full scan. Optional later: a TTL cache keyed by `jti` (see N1).
- **Replay cache rule (PR #5 review N1):** any future replay cache must key on `jti` or on the decoded signature bytes, never on the token string: base64url signatures are non-canonical (trailing bits), so one signature has several token spellings. N4 (the query string is ignored by the route match) is harmless; no change.
- **B9-7 must (DONE in B9-7):** leave `QP_REGION` out of `render.yaml` (qstash rejects it as a Cloud Tasks setting), even though `infra/spec.mjs` sets it for the GCP path.
- **B9-2 done on `claude/b9-2-qstash-adapter`** (`QStashQueue`, `QSTASH_URL`, `LocalDispatchQueue` `qstash` profile). Not yet verified against the real service; the checks below are mandatory for B9-9.
- **B9-9 live checks for the QStash adapter** (none of this has been run; all unit tests use a fake fetch):
  1. A real publish through `QStashQueue` answers **201** with a `messageId` and the worker receives exactly one delivery.
  2. Publishing the same `(requestId, seq)` again answers **201 with `"deduplicated":true`** (the adapter maps both to CREATED; ADR-019 measured it in a spike, docs say 202). Record the exact status and body, and whether the repeat counts toward the daily message limit.
  3. The free-plan maximum for `Upstash-Timeout` (config allows 60 s to 15 min, QStash's documented maximum). If the plan caps it lower, lower `QSTASH_TIMEOUT_MAX_MS` in `packages/core/src/config.ts`.
  4. `QSTASH_URL` region matches the token: a wrong region answers 401/403/404 and must show as a permanent `ENQUEUE_FAILED:UNAUTHENTICATED|PERMISSION_DENIED|NOT_FOUND` log line, never as a retried transient failure.
  5. A 429 (quota or rate) is seen as `ENQUEUE_FAILED:RESOURCE_EXHAUSTED` with `retryAfterSeconds` when QStash sends `Retry-After`; check whether QStash sends it at all.
  6. The deduplication retention actually applied (docs say 90 days; the local profile uses that figure, unmeasured).
  7. Deliveries carry `Upstash-Retried`; the worker does not read it yet (it logs `taskRetryCount` only from `x-cloudtasks-*`), decide in B9-3 whether to map it.
- **B9-7 DONE on `claude/b9-7-free-deploy-files`** (ADR-019 B9-7 acceptance; all offline, nothing run against Render, Firebase or Upstash): `render.yaml` (two free Docker web services, Frankfurt, `/health`, `autoDeploy: false`, every owner value or secret `sync: false`, `TRUST_PROXY_HOPS=3` and `QP_CORS_ORIGINS` on the API, no `QP_REGION`, no Cloud Tasks or emulator variables), `firebase.json` + `.firebaserc` (placeholder id; Hosting SPA with security and cache headers, Firestore rules and indexes reused from `infra/`, emulator block kept, nothing that needs Blaze), `scripts/qstash-setup.mjs` / `qstash-shutdown.mjs` (dry run default, `--apply --approve-destination`, token from the environment only, re-read confirmation), `preflight.mjs --profile free` (render.yaml and firebase.json consistency, `WARN` for qstash with `TRUST_PROXY_HOPS` 0), `seed-demo.mjs --profile free --tenant-daily-limit`, runbook "Free-tier path". Step 0 finding: before this change the apps called `initializeApp({ projectId })` with no credential, so Firestore relied on application default credentials, which Render does not have; new `QP_FIREBASE_SERVICE_ACCOUNT_JSON` (one secret, `createFirebaseApp` in `packages/core/src/firebase.ts`). Decisions: `QP_MAX_INSTANCES=1` (one free instance), no Content-Security-Policy on Hosting (the API origin is unknown until deploy and a wrong policy would break Google sign-in; revisit in B9-9), `COOP same-origin-allow-popups` for the sign-in popup, the strict-subset YAML reader instead of a new dependency.
- **B9-9 live checks for B9-7** (none of this has been run):
  1. Render accepts the Blueprint on the free plan without a payment method, prompts for every `sync: false` value, and the Docker build with `dockerContext: .` finds `.dockerignore` and the pnpm workspace. Both `/health` checks pass. The injected `PORT` (expected 10000) is what the apps bind.
  2. A service started with `QP_FIREBASE_SERVICE_ACCOUNT_JSON` reads and writes Firestore; a wrong key fails at boot with the constant message. Token verification works with that app.
  3. QStash API shapes assumed by `scripts/lib/qstash.mjs` (from memory, unverified): `GET /v2/schedules` returns an array with `scheduleId`, `destination`, `cron`, `method`, `retries`, `isPaused`; `POST /v2/schedules/<destination>` with `Upstash-Cron`, `Upstash-Method`, `Upstash-Retries`, `Upstash-Timeout` answers 200 or 201 with `scheduleId`; `Upstash-Schedule-Id` updates in place; `DELETE /v2/schedules/<id>` answers 200 or 204. The QStash list schema documents no timeout (review fix F3), so the script treats every existing schedule as needing an in-place upsert and never claims "unchanged" unless a listing happens to show an equal timeout; confirm the real listing has no timeout and that the upsert under `Upstash-Schedule-Id` keeps one schedule. If the real shapes differ, the re-read check fails loudly instead of claiming success.
  4. `firebase deploy --only hosting,firestore` works on Spark with `infra/firestore.indexes.free.json` (the same indexes, no TTL overrides; review fix F1), and `Cross-Origin-Opener-Policy: same-origin-allow-popups` keeps the Google popup working.
  5. `seed-demo` and `grant-role` work against a Spark project with the `queuepilot-environment=demo` label set through `gcloud projects update`.
  6. The sandbox cap of 300/day is enough for the demo and still inside Spark's 20K writes/day (7 writes per request).
- **Ownership note (B9-7):** this branch touches Codex-owned paths on the owner's instruction (Codex is not available): `packages/core/src/{config,log,firebase,index}.ts` and `packages/core/test/firebase.test.ts` (the one allowed code change), `apps/{api,worker}/src/runtime.ts` (one line each), `scripts/**`, `tests/unit/firebase-credential.test.ts`, `tests/integration/services.test.ts` (the Firestore emulator test, adapted to the deny-all rules that `firebase.json` loads; F12), `firebase.json`, `.env.example`. New root files: `render.yaml`, `.firebaserc`.
- **B9-7 review fixes DONE on `claude/b9-7-review-fixes`** (follow-up to the merged PR #8; all offline, nothing run against Render, Firebase or Upstash). F1: the free `firebase.json` deploys `infra/firestore.indexes.free.json` (same composite indexes, no `ttl` overrides: TTL deletes need billing; the paid file is unchanged) and the free preflight parses the referenced indexes file and FAILS on any `ttl` that is not `false`; expiry stays logical (ADR-005), expired demo data is not auto-deleted. F2: in production `loadConfig` requires `QP_FIREBASE_SERVICE_ACCOUNT_JSON` when `RENDER` is set (API and worker; Cloud Run unaffected); `/ready` already makes one real Firestore read with the credential in both services (now tested for the worker too), `/health` is untouched and `/ready` is not the Render health check. F3/F14: the QStash listing has no timeout, so an existing schedule is upserted in place on every apply and "unchanged" is claimed only when a listing shows an equal timeout; regional URL shape is `https://qstash-<region>.upstash.io`. F6: `Upstash-Timeout` is `^\d+[smh]$` within 60 s to 15 min in config and scripts. F7: `Cache-Control: no-cache` on `**`, immutable only on `/assets/**` (declared after `**`), COOP value checked by the preflight. F9: `autoDeployTrigger: off`. F10/F16/F17: rules compared to the canonical text, quoted `plan` values read, `crypto.createPrivateKey` in `parseServiceAccount`. F11: blank `QSTASH_URL` is the default; empty `QP_CORS_ORIGINS` under production qstash logs a boot `CONFIG_WARNING` (`configWarnings`, no failure, the Cloud Run/same-origin case stays valid). F4/F5: runbook step 0 "Prerequisites", 0b with the real preflight output categories, `.firebaserc` is never edited (`--project` everywhere), step 4.2 "no Render prompt may be left empty", `/ready` check after the first deploy, shutdown rewritten. F15: test sentinel fixed. Logger redaction now covers nested config (3 levels) and `privateKey`/`private_key` (5 levels), measured at about 30 us per log line against about 3.5 us before. Mutation gaps 1 to 7 of the review are covered by tests that were each proven by a temporary mutation (PR description).
- **Config doctor DONE on `claude/config-doctor`** (follow-up to the first live Render deploy, where both services exited with the constant `Invalid API configuration`; all offline, nothing run against Render, Firebase or Upstash). `loadConfig` now collects every failure and throws a `ConfigError` whose message and `issues` hold variable **names and reason codes only** (`missing`, `blank`, `whitespace`, `wrong_format`, `not_https`, `not_origin`, `not_rediss`, `invalid_json`, ...), never a value and no `cause`; the existing named messages are kept and gain a `[NAME reason]` suffix. API and worker share the loader. New `node scripts/config-doctor.mjs --service api|worker --env-file <path> [--service-account-file <path>]` builds the Render environment (strict-subset `render.yaml` reader + env file + minified key), calls the same `loadConfig`, prints PASS or FAIL with names and reasons, plus presence, length and a whitespace flag per variable; it refuses a file inside the repository and never prints a value or calls the network. Runbook step 3a documents it. Tests: `tests/unit/config-diagnostics.test.ts`, `scripts/config-doctor.test.mjs` (in the root `pnpm test`), two anchored regexes adapted in `tests/unit/{firebase-credential,queue-backend-config}.test.ts`. Findings: a blank `QSTASH_URL`, a space after a CORS comma and a trailing space on a URL are **accepted** by the loader by design (blank counts as unset, entries and `z.url()` trim), so the doctor passes them and notes blanks. Not verified: how Render itself stores values (B9-9).
- **Ownership note (config doctor):** touches Codex-owned `packages/core/src/config.ts` and `tests/unit/**` on the owner's instruction (Codex is not available), plus `scripts/**` and docs. No change to which variables exist, nor to queue, worker or web logic.
- **B9-9 live checks from the B9-7 review** (none of this has been run):
  1. A Blueprint created from a **Hobby** workspace never asks for a card or payment method (both services show Free).
  2. How Render stores a blank `sync: false` prompt (does it block creation, or store an empty string?) and a multi-line JSON paste for `QP_FIREBASE_SERVICE_ACCOUNT_JSON`; if the paste is mangled, the one-line fallback in the runbook step 4.2 works.
  3. F8, Hosting headers on `/__/auth/*`: `X-Frame-Options: DENY` (set on `**`) versus `/__/auth/iframe`, which Google popup sign-in loads in a frame. Sign in with Google on the live Hosting site; if it breaks, scope the header to the app paths instead of `**` (and keep `Cross-Origin-Opener-Policy` in step). Also check which `Cache-Control` wins on `/assets/*.js` (Hosting documents only that matching rules apply "in the order they are defined"): expected `public, max-age=31536000, immutable` on assets and `no-cache` on `/` and `/index.html`.
  4. The free-plan maximum of `Upstash-Timeout` (see the QStash adapter checks, item 3): confirm 15 min, or lower `QSTASH_TIMEOUT_MAX_MS`.
  5. TTL absence on Spark: `firebase deploy --only firestore` with the free indexes file works; expired `idempotencyKeys` are still taken over by the code; note the Firestore storage growth after the demo.
  6. `GET /ready` answers 200 on both Render services after the first deploy, and 503 with a deliberately wrong service-account key (then restore it).
  7. Render really sets the `RENDER` environment variable on a Docker web service (the production credential requirement relies on it); if not, the guard is inactive and `/ready` is the only signal.
- **B9-5 (PR #4 F4):** record `error.message` (`ENQUEUE_FAILED:<CODE>`, value-free) as `dispatch.lastError` instead of the generic `ENQUEUE_FAILED`, so quota exhaustion (`RESOURCE_EXHAUSTED`) is distinguishable. `Retry-After` (`retryAfterSeconds`) is still unused by consumers.
- **Local `qstash` profile assumptions (PR #4 F7):** it keeps the Cloud Tasks rate (20/s) and concurrency (30) and honours `Retry-After` on every non-2xx up to 86400 s. None of this is measured QStash behaviour; documented as assumptions in the profile's comments.
- **Before B9-9 (PR #4 F8):** run the emulator suite, T1-T13 and the race suites once with the `qstash` local profile; the factory never selects it today, so nothing has exercised it end to end.
- **Ownership note (PR #4 F10):** `apps/worker/README.md` is Codex-owned and was edited in B9-1 and B9-2 (docs lines only); flag it in the PR ownership note.

## CCR log

_(none)_  T1 row note: ADR-017 gives seq=2 after a lost API enqueue (the card text above still says seq=1).

## Integration log

- 2026-10-19: A2.2 (`46e871b`, cherry-picked `-x` as `f9fe0df`) integrated; ADR-017 added, ADR-014 superseded, ADR-011/I7 amended. Domain-only change, no contract changes.
- 2026-10-19: A2 (`5c71837`) and B2 (`5b1b556`) merged with `--no-ff`. Combined: lint, typecheck, build pass; 449 unit tests (18 files). ADR-014 to ADR-016 added from A2/B2 handoffs.

**A3 + B3 merge notes (2026-10-19).** Merged `claude/a3-web` and `codex/b3-backend` with `--no-ff` (no overlapping files). Integration fixes: (1) API error handler now mirrors `Retry-After` into the Problem body as `retryAfterSeconds` (contract `ProblemDetailsSchema`; the web UI reads only the body). (2) Root `pnpm test` now runs `scripts/test.mjs`: node suites + web jsdom suite + `infra/*.test.mjs`. (3) Root integration config adds `apps/api/test/integration`; `scripts/integration.mjs` also runs the frontend-to-API smoke (`apps/web/smoke/`, spawns `apps/api/dist/server.js`, so CI now builds before integration). Not a CCR: no contract change. Pending: B3 emulator suite and the smoke were not run on the merged tree (port 8080 held by an orphaned emulator; see PROJECT_STATE).
- 2026-10-20: B4 (`577263a`, merge `3b07080`) and B5 (`35efa81`, merge `9bc5949`) merged with `--no-ff`. Codex's sandbox could not spawn processes or commit, so Claude ran every check and committed. Integration fixes by Claude: web smoke config root + `SMOKE_API_PORT` (`7ce2252`; the smoke step had found no files before), `queue.test.ts` fixture timing, root workspace deps `@queuepilot/core` and `@queuepilot/contracts` (`71f060d`, `47e4fd1`; hand-made symlinks had hidden the missing links), `ioredis` kept external in API/worker bundles (`a15020b`; the bundled worker crashed at startup). ADR-018 added from the B5 handoff.
- 2026-10-20: B6 local load suite (`tests/load`, Node, no k6). Written by Claude directly (Codex not available in this session), so no Codex-owned path was touched by anyone else. Results in `tests/load/results/`. Intermittent `infra/offline.test.mjs` failure reproduced under CPU load: 5 s timeouts around `fork`/`spawnSync` of `scripts/spike/server.mjs` (warm start 0.7 s). Follow-up for the infra owner: raise those timeouts (lines ~198 and ~222).
- 2026-10-20 (session 2): pushed B6 (`6bfd81a`; origin was at `8c5b1dd` because the B6 merge had never been pushed; fast-forward, no divergence). Fixed the `infra/offline.test.mjs` flake (`abf0919`): `waitReady()` races the ready message against child exit with captured stderr and a 30 s hang bound; 31/31 pass 5 of 5 times under 16 CPU burners on 12 cores. Added real-Redis tests `tests/integration/redis-adapters.test.ts` (9) and `apps/api/test/integration/redis-quota.test.ts` (5, HTTP + Firestore emulator + Redis); both passed first time in CI (run 39411182093). README.md rewritten, README.tr.md and `docs/DEMO.md`, `docs/DEPLOYMENT_RUNBOOK.md` added. Claude wrote all of it directly (Codex sandbox cannot run processes here), including files under Codex-owned paths (`infra/`, `apps/api/test/`, `tests/`, `README*.md`), on the owner's explicit instruction. No license added: owner decision pending.
- 2026-10-20 (session 4): B7 pre-deployment hardening on `claude/b7-predeploy-hardening`, pushed as a feature branch only (owner-approved in-session); `main` untouched and not
  pushed. Found that a parallel session had created and pushed `claude/b7-preflight` meanwhile; the owner chose to build on it rather than duplicate. Local: lint, typecheck,
  test (node + web + infra + owner scripts), build pass; owner-script emulator suite 3/3 (Firestore + Auth emulators on alternate ports, because an orphan emulator from the
  parallel session holds 8080); pruned runtime (`pnpm deploy --prod --legacy`, no `@queuepilot`) started on Windows with production-shaped settings: 14/14 checks. Docker,
  gcloud and Redis are not installed locally; image build/smoke and full integration are CI evidence only. First branch CI run (39434575888) failed only on an over-broad smoke
  file check that flagged a third-party `*.test.d.ts` under `node_modules`; the check now scans repository-origin paths and keeps the workspace-source and `re2` checks.
