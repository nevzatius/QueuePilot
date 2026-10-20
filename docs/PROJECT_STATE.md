# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-20 (session 2), by Claude Code (GitHub sync, real-Redis tests, flake fix, docs).

## Phase

Architecture v0.2 frozen (ADR-009 to ADR-018). Merged on `main`: B1, A1, A2/A2.2, B2 (offline scripts), A3 (web), B3, B4, B5, B6 (local).
Remote: private `github.com/nevzatius/QueuePilot`. No cloud resource exists. The local MVP works end to end on emulators.
B7 (cloud deployment) not started; owner runbook prepared in `docs/DEPLOYMENT_RUNBOOK.md`.

## Milestones

| ID | Gate | Status |
|---|---|---|
| M1 | A1 + B1 merged, CI green | **done**: CI runs on GitHub and passes (Actions tab) |
| M2 | C1–C9 verified, skeleton deployed | **C1–C9 NOT RUN (owner)** |
| M3 | B3 on emulator | done |
| M4 | B4 COMPLETED end to end | **local: done**; cloud: not run |
| M5 | B5 Redis with fallbacks | **real-Redis suites PASS in CI** (Lua, adapters, HTTP quota path); cloud/Upstash not run |
| M6 | B6 baseline/spike/Redis on-off, 3 reps | **local done** (`tests/load`); real-Redis load variant and k6 NOT RUN |
| M7 | README EN/TR with measured results | **done** (`README.md`, `README.tr.md`); numbers are local and labelled so |

## Checks (2026-10-20)

- GitHub Actions on `main` for the B6 merge: success (run 39410411597). Branch run with the new Redis tests: success (run 39411182093):
  546 node + 35 web tests, 31 infra tests, integration 66 tests (6 files, emulators + real `redis:7.4`), web and worker smoke.
- Clean clone of the branch (`pnpm install --frozen-lockfile`, lint, typecheck, build, test): all pass locally (546/35/31).
- Local `pnpm test:integration` cannot run on the dev machine (no Redis); CI is the evidence for it.
- Infra flake: `waitReady()` replaces a fixed 5 s timeout; 31/31 pass in 5 of 5 runs under 16 CPU burners. Not a proof the race is gone, only that it no longer reproduces.
- Local E2E (`docs/verification/e2e-local.mjs`, 25/25) and load figures: see README and `tests/load/results/`. Local, emulators, 20/s local queue model.

## Blockers (owner actions)

1. GCP demo project, billing, budget alerts, region `europe-west1` approval (irreversible, ADR-007); run C1–C9 via `infra/CLOUD_VERIFICATION.md`.
2. Missing for B7: Dockerfiles for `apps/api` and `apps/worker`, deploy/shutdown wrapper, `scripts/grant-role.ts` (no admin can be created in the cloud without it), tenant/membership seeding.
3. Upstash (or other TLS Redis) account and secret version; Firebase Google provider and authorized domains.
4. License choice: none added; repository stays unlicensed until the owner decides.
5. Optional: two orphan `java` Firestore emulators from the earlier session may still hold ports 8080/9150 and 18080/19150 (`Stop-Process` needs the owner); approve or reject pnpm build scripts `re2`, `@firebase/util` (nothing needs them).

## Known risks

- Cloud Tasks semantics behind ADR-003/011/017 are unverified until C1–C9; `CloudTasksQueue` uses Cloud Tasks v2 REST via `google-auth-library`, also unverified live.
- Redis client timeouts are 100 ms; a remote Redis (Upstash) may fail closed more often than local until C8 measures latency.
- Codex's sandbox cannot spawn processes or commit on this machine: Claude runs all checks and wrote this session's changes, including under Codex-owned paths, on the owner's instruction.
- CI warnings not acted on: Node 20 runtime deprecation for some actions, `setup-java` v5 suggestion, `ubuntu-latest` transition. No behavioural impact so far.
- `scripts/integration.mjs` leaves an orphan emulator on Windows; CI (Linux) is unaffected.

## Next step

1. Owner: decide on the cloud project and billing; then follow `docs/DEPLOYMENT_RUNBOOK.md` (sections A–I).
2. B7 work items (Claude/Codex): API/worker Dockerfiles, grant-role script, deploy/shutdown wrapper; then run C1–C9 with the owner.
3. Optional: run the `redis-on` load variant once a Redis exists (`QP_LOAD_REDIS_URL`); rehearse `docs/DEMO.md` against the local UI.
