## Work package

WP ID: B2.1 (targeted B2 infrastructure corrections)
Branch: `codex/b2-cloud`
Agent: Codex
Worktree: `<worktrees-dir>/codex-b1-foundation`
Review base: `5bd6cddaf5130ac8f7a76a973c06962885125754`
Local main: `39cc4369753f027ce0dedab24180682e954d62bf` (already an ancestor; no remote fetch).
Delivery SHA: obtain with `git log -1 --format=%H codex/b2-cloud`.

## Summary

Fixed H1 with resource-specific IAM policy-read methods, paths and version-3 options placement; policy merging and least-privilege runtime grants are preserved.
Fixed M1 by deferring Scheduler creation until explicit image approval and deployed worker readiness; provisioning pauses and verifies existing active queues/jobs as well as new resources, and pause failures exit nonzero.
Fixed M3 with exact project and irreversible `europe-west1` consent checked before credentials and again at the database creation boundary.
Fixed M5 by normalizing Scheduler retry defaults/durations, ignoring inactive backoffs only when retries are disabled, and reporting Firestore index/field operations as PENDING until state reads confirm readiness.
Verified M2: TTL and single-field exemptions remain configured together; added Resource Manager to API prerequisites. No cloud resources or application state-machine code were changed.

## Ownership check

- [x] Only B2-owned infrastructure files/tests changed: `infra/**`, `scripts/spike/setup.mjs`.
- [x] `docs/TASKS.md`, `docs/PROJECT_STATE.md` and `docs/DECISIONS.md` are untouched.
- [x] Contracts/domain, web, Claude files, root tooling and B3 code are untouched.

Changed files:

- `infra/cloud.mjs`: resource-specific IAM reads; pause/read-back safety; explicit database creation consent; Scheduler deployment approval/readiness; retry normalization; pending index/field results.
- `infra/apply.mjs`: `--approve-firestore-location` and `--approve-b4-worker-image`; pre-credential validation and approval propagation.
- `infra/spec.mjs`: Resource Manager prerequisite, minimal disabled-retry Scheduler configuration and target image/service metadata; removed obsolete project-policy method flag.
- `scripts/spike/setup.mjs`: isolated Scheduler target metadata and separate `--approve-spike-worker-image` gate.
- `infra/offline.test.mjs`, `infra/targeted.test.mjs`: retained baseline coverage and added exact HTTP URL/method/body, policy preservation, approval, readiness, idempotency, pause-failure/CLI-exit and pending-operation regressions.
- `infra/README.md`, `infra/CLOUD_VERIFICATION.md`, `infra/HANDOFF.md`: operator approval, recovery, verification and review instructions.

## Acceptance criteria (copy from the WP card)

- [x] Prepare idempotent gcloud-backed infrastructure scripts covering APIs, service accounts, IAM (ARCHITECTURE section 14), queue, scheduler, Firestore indexes, TTL policies and rules, and Hosting rewrite. This correction changes only the reviewed B2 defects.
- [x] Offline repeated-run tests converge without unexpected IAM changes or Scheduler UPDATE loops.
- [ ] Re-running scripts in the cloud is a no-op: NOT RUN; cloud convergence remains an owner gate. Provisioning intentionally pauses active queues/jobs.
- [ ] Run C1-C9 and post results for ADR-003, ADR-011 and ADR-007: all NOT RUN, as required for this offline correction.

| Check | Status |
|---|---|
| C1 completed task getTask | NOT RUN |
| C2 live/deleted-name deduplication | NOT RUN |
| C3 task headers | NOT RUN |
| C4 dual-condition retry deletion | NOT RUN |
| C5 409/backoff and platform 429 | NOT RUN |
| C6 unauthenticated rejection / Tasks+Scheduler OIDC | NOT RUN |
| C7 Hosting Authorization forwarding | NOT RUN |
| C8 Cloud Run to Upstash latency | NOT RUN |
| C9 queue-scoped get permission / PROBE_UNKNOWN | NOT RUN |

## Invariants and ADRs touched

I1-I7: no domain decisions, application data or state transitions changed. Infrastructure does not derive business attempts from Cloud Tasks headers.
ADR-011: exact queue create/get grants are unchanged; failed IAM/resource reads propagate and do not imply absence or trigger writes.
ADR-007: exact project and `europe-west1` confirmation is now executable consent, not an implicit default.
TTL design is preserved: each `expiresAt` has both `indexConfig.indexes=[]` and `ttlConfig={}` with update mask `indexConfig,ttlConfig`.

## Verification

- [x] `corepack pnpm lint`: PASS, zero warnings. Corepack invokes the pinned pnpm; no global installation.
- [x] `corepack pnpm typecheck`: PASS.
- [x] `corepack pnpm test`: PASS, 165 unit tests across 8 files.
- [x] `corepack pnpm build`: PASS.
- [x] `node --test infra/offline.test.mjs infra/targeted.test.mjs`: PASS, 31 tests. Includes all main/spike IAM call sites, serialized HTTP requests, unchanged grants/etags/conditions/audit config, repeated-run convergence, approval/readiness failures, verified pauses and CLI nonzero exits.
- [ ] Integration tests (IO touched): `corepack pnpm test:integration` attempted; Firestore and Auth emulator tests PASS (2/3), Redis test FAIL (1/3), `ECONNREFUSED 127.0.0.1:6379`. No Redis/Memurai/Docker executable is available on PATH. Emulators shut down normally. Existing Linux emulator+Redis CI must pass before merge.
- [ ] Cloud deployment, activation, actual queue/job state, TTL activation and asynchronous deletion verification: NOT RUN. Public REST documentation was consulted without authenticated project access. No credentials, push, merge, cloud modification or deployment was used.

## Security and cost impact

No actual cloud security or cost impact; all work and tests are local. No runtime grant was widened. Policies retain version 3, etags, conditional/unrelated grants and audit configuration.
An absent main reconciliation job is DEFERRED unless the owner explicitly approves the exact B4 worker image; the corresponding Cloud Run service must also report a ready current revision with that image. Spike jobs require a separate probe-image approval.
Scheduler state is output-only, so approved creation and pause are not atomic. A short execution window remains after approved creation; before approval no job is created. Queue creation also has a create-to-pause window: do not enqueue concurrently.
Provisioning pauses existing active resources, including reapplication after a partial creation. Failed pause or failed PAUSED read-back is an error, never NOOP. Pause does not cancel already in-flight requests. Activation/resume remains a separate owner action after application review and cloud checks.

## Handoff notes (for PROJECT_STATE.md)

H1, M1, M3 and M5 are corrected and covered offline; M2's combined TTL/exemption design remains intact.
All C1-C9 and actual TTL deletion evidence remain NOT RUN; actual cloud resource states were not inspected.
Before the main data stage, supply exact project plus `--approve-firestore-location=europe-west1`. Before creating the main job, deploy/review B4 and pass `--approve-b4-worker-image=FULL_PINNED_WORKER_IMAGE`.
PENDING data results require subsequent READY/ACTIVE reads; TTL activation and actual expired-record deletion must be verified separately.
Merge readiness: ready for independent B2.1 code review; not ready to merge until Redis-backed integration CI is green and the integration owner approves. No B3 work was begun.

## CCRs and ADR proposals

CCRs: none. No new ADR update is required for B2.1: these are implementation corrections within the frozen design. Architecture/decision files were not edited.
Earlier B2 ADR-003/011/007 cloud-evidence and provisioning-prerequisite follow-ups remain pending; this correction supplies no C1-C9 evidence and does not resolve them. Resource-specific IAM REST references and Scheduler/TTL documentation are linked in [README.md](README.md).
