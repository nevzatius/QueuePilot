## Work package

WP ID: B2
Branch: `codex/b2-cloud`
Agent: Codex
Worktree: `D:/Oyun/QueuePilot-worktrees/codex-b1-foundation`
Base: `39cc436` (main). Delivery commit: use `git log -1 --format=%H codex/b2-cloud`.

## Summary

Prepared reproducible, staged Google Cloud infrastructure with credential-free plans and explicit owner-only application.
Configured API/private worker Cloud Run services, Tasks retries/rate/concurrency, OIDC, Scheduler, scoped runtime IAM, secret references, Firestore rules/indexes/TTL and a Hosting rewrite.
Added isolated cloud probe setup, a bounded probe handler/CLI, and a C1–C9 runbook with truthful NOT RUN evidence.
Added offline reconciliation/isolation tests; no application state-machine logic was implemented.
No authenticated cloud calls, deployments, IAM changes, pushes or merges occurred.

## Ownership check

- [x] Only paths owned by this agent were changed: `infra/**`, `scripts/spike/**` (infrastructure-related scripts and probes only).
- [x] `docs/TASKS.md`, `docs/PROJECT_STATE.md` and `docs/DECISIONS.md` are untouched (integration owner only).
- [x] `packages/contracts/**`, `packages/domain/**`, `apps/web/**`, `CLAUDE.md` and `.claude/**` are untouched.

Changed files:

- `infra/apply.mjs`, `infra/cloud.mjs`, `infra/spec.mjs`, `infra/config.example.json`: staged reconciliation, configuration, IAM and safety gates.
- `infra/firestore.rules`, `infra/firestore.indexes.json`, `infra/firebase.json`: deny-all client rules, composites/exemptions/TTL and main Hosting configuration.
- `infra/offline.test.mjs`: script syntax, configuration/IAM consistency, read-failure safety, mocked convergence and local probe isolation checks.
- `infra/README.md`, `infra/CLOUD_VERIFICATION.md`, `infra/cloud-results.not-run.json`, `infra/HANDOFF.md`: owner runbooks, status and handoff.
- `scripts/spike/setup.mjs`, `scripts/spike/probe.mjs`, `scripts/spike/server.mjs`: isolated setup, safe create/get observations, response/header/Redis probes.
- `scripts/spike/Dockerfile`, `scripts/spike/package.json`, `scripts/spike/package-lock.json`: isolated Node 24 probe container and pinned dependency graph.
- `scripts/spike/firebase.json`, `scripts/spike/public/index.html`: separate synthetic-header Hosting test site.

## Acceptance criteria (copy from the WP card)

- [x] Prepare idempotent infrastructure scripts covering APIs, service accounts, IAM (ARCHITECTURE §14), queue, scheduler, Firestore indexes, TTL policies and rules, and Hosting rewrite. gcloud supplies short-lived authentication; state reconciliation uses Google REST APIs.
- [x] Offline repeated-run no-op checks passed for managed resource/policy responses, including server defaults and output fields.
- [ ] Owner cloud reapplication is confirmed as a no-op. Pending actual provisioning/provider normalization checks; identity generation is an idempotent ensure call.
- [ ] Run C1–C9 and post results for ADR-003, ADR-011 and ADR-007. **All NOT RUN**; the requested offline fallback is complete. Test plans and isolated probes are ready.

| Check | Status |
|---|---|
| C1 completed task getTask | NOT RUN |
| C2 live/deleted-name deduplication | NOT RUN |
| C3 task headers | NOT RUN |
| C4 dual-condition retry deletion | NOT RUN |
| C5 409/backoff and platform 429 | NOT RUN |
| C6 unauthenticated rejection / Tasks+Scheduler OIDC | NOT RUN |
| C7 Hosting Authorization forwarding | NOT RUN |
| C8 Cloud Run → Upstash PING p50/p95 | NOT RUN |
| C9 queue-scoped get permission / PROBE_UNKNOWN | NOT RUN |

## Invariants and ADRs touched

I1–I7: no application data/state transitions were implemented or changed. In particular, queue retries/headers never become the business budget, and no infrastructure error increments dispatch seq.
ADR-003/011: only explicit NOT_FOUND maps to ABSENT in the isolated probe; all other get failures map to PROBE_UNKNOWN. The actual B4 adapter still needs its own tests.
ADR-004/007: minute reconciler and `europe-west1`; region remains pending owner confirmation.
ADR-009/010/012: production runtime environment, fail-closed quota setting, 30 s membership TTL, ingestion settings, API/worker instance bounds and queue bounds are supplied; application enforcement belongs to B3–B5.
ADR-013: shared status/decision files were not edited; this description carries handoff/ADR proposals.

## Verification

- [x] `corepack pnpm install --frozen-lockfile`: passed; refreshed local workspace dependency links without changing the lockfile. Initial missing-Zod checks passed after this local install. No global tools installed.
- [x] `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm build`: passed (165 tests in 8 files; Corepack runs the pinned pnpm 10.32.1 because pnpm is not on PATH).
- [x] `node --test infra/offline.test.mjs`: passed, 18 tests, including `node --check` on all new mjs files and local HTTP isolation tests.
- [x] Compared 42 main/probe desired resource bodies against public Google API discovery schemas without authentication/project access; no unknown properties or invalid enums.
- [x] Main/probe setup/probe CLI offline plans run successfully with gcloud absent from PATH.
- [x] Reviewed createTask/getTask permission requirements, queue-level IAM support, platform service-agent/OIDC prerequisites, image/secret prerequisites and cost bounds against primary documentation. Live IAM still requires C9.
- [ ] `corepack pnpm test:integration`: attempted, **BLOCKED** before tests because Firestore emulator port `127.0.0.1:8080` is already occupied. Existing process was not interrupted. Redis/Memurai and Docker are also unavailable in this session. Run the existing Linux CI emulator+Redis integration suite before merge.
- [ ] C1–C9 cloud checks, actual container build, provider deployment readiness and paid-resource convergence: NOT RUN. No cloud credentials were inspected or used.

## Security and cost impact

No current cloud security or cost impact: changes are local preparation only. On approved execution, scripts enable APIs, create demo infrastructure, merge scoped IAM grants, enable TTL and deploy compute; separate owner approval is required for those actions.
Only main API and isolated synthetic-header service are public. Worker IAM checks are explicitly enabled; direct public worker bindings abort IAM setup. Inherited IAM must be audited by the owner.
Runtime accounts receive exact queue create/get custom permissions, datastore.user, secret-scoped Redis access and actAs on the Tasks invoker; no service-account keys, runtime token-creator, Auth admin, queue-admin or broad Tasks viewer grants.
Tasks/Scheduler platform agents retain their dedicated service-agent roles. Tasks agent receives actAs on the attached invoker only, following the current HTTP-target guide.
New queues/jobs are paused immediately after creation; reapplication never activates existing paused resources. Creation-to-pause is not atomic, so concurrent enqueueing is forbidden until activation approval.
Main caps: API 0–5, concurrency 80; worker 0–3, concurrency 10; queue 20/s and 30 concurrent. Probe caps: each Run service 0–1/concurrency 1, each queue 1/s/1 concurrent, bounded tasks/retry windows and 60 total PINGs. Budget alerts and shutdown remain owner gates, not automatic billing changes or hard spending caps.
Secret payloads are never read by setup or printed by probes; the Redis container reads a pinned Secret Manager reference only when the owner runs it. Handler logs allowlisted queue/scheduler metadata, never authorization, cookies, descriptions or bodies.

## Handoff notes (for PROJECT_STATE.md)

B2 offline infrastructure preparation and 18 offline/isolation tests are complete on `codex/b2-cloud`; cloud verification is not complete.
All C1–C9 remain NOT RUN; owner needs a demo project/billing/region decision, local gcloud, Firebase setup, TLS Upstash secret version and approved immutable images.
Current API/worker are skeletons; actual deployment/activation requires B3/B4 authentication, configuration, log redaction, quota and production fault-flag startup guards.
Integration rerun is blocked locally by occupied emulator port and unavailable Redis; use the existing Linux CI suite before merge.
Owner/integration lead should review the two ADR clarifications below, then execute the runbook in a dedicated demo project and post sanitized evidence.

## CCRs and ADR proposals

CCRs: none. No contract/domain/schema changes requested.

1. **ADR-003 / ARCHITECTURE §8 clarification:** replace the approximate 1 h named-task retention assumption with a conservative statement that [createTask documentation permits up to 24 h](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create) for API-managed queues (legacy queue.yaml/xml differs). C2 must record measured bounds, not assert a fixed 1 h TTL. Keep named task generation and proven-absence rules unchanged until cloud evidence is reviewed; retain the approved time-based fallback if C1/C2 contradict reconciliation assumptions.
2. **ARCHITECTURE §14 deployment prerequisite clarification:** document Tasks/Scheduler platform service-agent roles, Tasks-agent actAs on the attached invoker, owner actAs for deployed identities, numeric secret-version readiness and inherited-IAM audit. These complete provisioning prerequisites without expanding runtime queue permissions. Current [HTTP-target setup guide](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks) explicitly calls for Tasks-agent Service Account User on the invoker. Runtime grants stay as approved.

ADR-007 and ADR-011 retain pending status until owner region confirmation, C8 latency evidence and C9 queue-scoped permission evidence. No ADR files were modified. Proposed environment keys in `infra/spec.mjs` must be aligned with B3/B4 config parsing before activation; this needs coordination, not a shared contract change.
