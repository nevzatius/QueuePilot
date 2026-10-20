# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-20 (session 4), by Claude Code (B7 pre-deployment hardening on `claude/b7-predeploy-hardening`, not merged).

## Phase

Architecture v0.2 frozen (ADR-009 to ADR-018). Merged on `main` (`7e6eb41`): B1, A1, A2/A2.2, B2 (offline scripts), A3 (web), B3, B4, B5, B6 (local).
Remote: private `github.com/nevzatius/QueuePilot`. No cloud resource exists. The local MVP works end to end on emulators.
B7 cloud deployment not started. Pre-deployment hardening is on feature branch `claude/b7-predeploy-hardening` (pushed, not merged; it contains
`claude/b7-preflight`): Dockerfiles, CI image job, guarded deploy/shutdown, read-only cloud preflight, grant-role, seed-demo. Owner runbook: `docs/DEPLOYMENT_RUNBOOK.md`.

## Milestones

| ID | Gate | Status |
|---|---|---|
| M1 | A1 + B1 merged, CI green | **done** |
| M2 | C1–C9 verified, skeleton deployed | **C1–C9 NOT RUN (owner)**; control matrix ready in the runbook §D |
| M3 | B3 on emulator | done |
| M4 | B4 COMPLETED end to end | **local: done**; cloud: not run |
| M5 | B5 Redis with fallbacks | **real-Redis suites PASS in CI**; cloud/Upstash not run |
| M6 | B6 baseline/spike/Redis on-off, 3 reps | **local done** (`tests/load`); real-Redis load variant and k6 NOT RUN |
| M7 | README EN/TR with measured results | **done**; numbers are local and labelled so |

## Checks (2026-10-20, session 4, B7 branch)

- Local (Windows): lint, typecheck, build pass; `pnpm test` 551 node + 35 web + 59 node:test (31 infra + 28 owner-script) pass.
- Emulator: `tests/integration/owner-scripts.test.ts` 3/3 (Firestore + Auth emulators, alternate ports). Full `pnpm test:integration` not run locally (no Redis).
- Runtime file set: `pnpm deploy --prod --legacy` output without `@queuepilot` + `dist/server.js`, production-shaped env: /health, 4 startup guards, worker 403, SIGTERM exit 0 (14/14, Windows, no Docker).
- Container images: built and smoke-run in CI only (Docker not installed locally). Run IDs in the session report / Actions tab.
- Security review of the branch (read-only agent): no real findings; low-severity hardening applied.

## Blockers (owner actions)

1. GCP demo project, billing, budget alerts, region `europe-west1` approval (irreversible, ADR-007); then C1–C9 per runbook §D.
2. Review and merge `claude/b7-predeploy-hardening` into `main` (and push `main`): owner decision. Unproven until a real project exists: images against real services,
   owner scripts against real Firestore/Identity Toolkit, cloud preflight against real APIs.
3. Upstash (or other TLS Redis) account and secret version; Firebase Google provider and authorized domains.
4. License choice: none added.
5. Orphan `java` Firestore emulators hold 127.0.0.1:8080/9150 (started 16:12 by the parallel session) and 127.0.0.1:18381 (this session's emulator run).
   Agents do not stop processes: stop them yourself if you need those ports. Untracked leftovers `apps/api/.deploy-test/` and `node_modules/.qp-scratch-deploy-test/`
   (parallel session) and `dist/qp-deploy-check-{api,worker}/` (this session's runtime check) are ignored or empty and can be deleted by you.
6. pnpm build scripts `re2` and `@firebase/util` stay unapproved (images do not need them; `re2` is absent from the runtime image).

## Known risks

- Cloud Tasks semantics behind ADR-003/011/017 are unverified until C1–C9; `CloudTasksQueue` (v2 REST) is unverified live.
- Redis client timeouts are 100 ms; a remote Redis may fail closed more often than local until C8 measures latency.
- `infra/apply.mjs --stage iam` has no public-API approval of its own; use `scripts/deploy.mjs` (which requires `--approve-public-api`).
- Two sessions edited this working tree in parallel today. Before integrating, check `git worktree list`/branches and avoid concurrent sessions on one checkout.
- `pnpm deploy` fails on Windows when the target is on another drive than the pnpm store (path join bug); use a same-drive target or Linux/Docker.
- `scripts/integration.mjs` and `emulators:exec` leave orphan emulators on Windows; CI (Linux) is unaffected.

## Next step

1. Owner: review the branch and decide on merge; decide on the demo project, billing and budget; then follow `docs/DEPLOYMENT_RUNBOOK.md` A–I.
2. With a project: `scripts/preflight.mjs --run`, stages via `scripts/deploy.mjs`, C1–C9, seed + grant-role (dry run first), one real `scripts/shutdown.mjs`.
