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
- **B9-3 must (F3, section 7):** add a `qstash` value to `QP_WORKER_AUTH_MODE`; production requires the mode matching the adapter (cloud -> oidc, qstash -> qstash) and rejects mismatches; branch `createCallerVerifier` to a QStash signature verifier that accepts both signing keys for both the tasks and scheduler callers (the reconciler tick also comes from QStash); keep the verifier-before-SDK-clients order and the local-auth check; add a test that `loadConfig(PROD_QSTASH)` followed by `createCallerVerifier` raises no OIDC error.
- **B9-7 must:** leave `QP_REGION` out of `render.yaml` (qstash rejects it as a Cloud Tasks setting), even though `infra/spec.mjs` sets it for the GCP path.
- **B9-2 done on `claude/b9-2-qstash-adapter`** (`QStashQueue`, `QSTASH_URL`, `LocalDispatchQueue` `qstash` profile). Not yet verified against the real service; the checks below are mandatory for B9-9.
- **B9-9 live checks for the QStash adapter** (none of this has been run; all unit tests use a fake fetch):
  1. A real publish through `QStashQueue` answers **201** with a `messageId` and the worker receives exactly one delivery.
  2. Publishing the same `(requestId, seq)` again answers **201 with `"deduplicated":true`** (the adapter maps both to CREATED; ADR-019 measured it in a spike, docs say 202). Record the exact status and body, and whether the repeat counts toward the daily message limit.
  3. The free-plan maximum for `Upstash-Timeout` (config allows 60 s to 15 min, QStash's documented maximum). If the plan caps it lower, lower `QSTASH_TIMEOUT_MAX_MS` in `packages/core/src/config.ts`.
  4. `QSTASH_URL` region matches the token: a wrong region answers 401/403/404 and must show as a permanent `ENQUEUE_FAILED:UNAUTHENTICATED|PERMISSION_DENIED|NOT_FOUND` log line, never as a retried transient failure.
  5. A 429 (quota or rate) is seen as `ENQUEUE_FAILED:RESOURCE_EXHAUSTED` with `retryAfterSeconds` when QStash sends `Retry-After`; check whether QStash sends it at all.
  6. The deduplication retention actually applied (docs say 90 days; the local profile uses that figure, unmeasured).
  7. Deliveries carry `Upstash-Retried`; the worker does not read it yet (it logs `taskRetryCount` only from `x-cloudtasks-*`), decide in B9-3 whether to map it.

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
