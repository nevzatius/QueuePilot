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
| B3 Platform, auth and ingestion | Codex | A1, A2, B1 | merged 2026-10-19 (`b6612bc`); emulator tests re-run pending (see notes) |
| B4 Queue, worker and reconciler | Codex | A2, B3 | todo |
| B5 Redis limits, quotas and cache | Codex | B3 | todo |
| B6 Load tests and verify | Codex | B4, B5, B2 | todo |
| B7 Deploy finalisation and README drafts | Codex | all | todo |

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

### B3 Platform, auth and ingestion: `packages/core/{config,log,auth,membership,idempotency,requests,admission,metrics}`, `apps/api`, `scripts/grant-role.ts`
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

## CCR log

_(none)_

## Integration log

- 2026-10-19: A2.2 (`46e871b`, cherry-picked `-x` as `f9fe0df`) integrated; ADR-017 added, ADR-014 superseded, ADR-011/I7 amended. Domain-only change, no contract changes.
- 2026-10-19: A2 (`5c71837`) and B2 (`5b1b556`) merged with `--no-ff`. Combined: lint, typecheck, build pass; 449 unit tests (18 files). ADR-014 to ADR-016 added from A2/B2 handoffs.

**A3 + B3 merge notes (2026-10-19).** Merged `claude/a3-web` and `codex/b3-backend` with `--no-ff` (no overlapping files). Integration fixes: (1) API error handler now mirrors `Retry-After` into the Problem body as `retryAfterSeconds` (contract `ProblemDetailsSchema`; the web UI reads only the body). (2) Root `pnpm test` now runs `scripts/test.mjs`: node suites + web jsdom suite + `infra/*.test.mjs`. (3) Root integration config adds `apps/api/test/integration`; `scripts/integration.mjs` also runs the frontend-to-API smoke (`apps/web/smoke/`, spawns `apps/api/dist/server.js`, so CI now builds before integration). Not a CCR: no contract change. Pending: B3 emulator suite and the smoke were not run on the merged tree (port 8080 held by an orphaned emulator; see PROJECT_STATE).
