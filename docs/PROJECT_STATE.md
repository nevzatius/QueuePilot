# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-20, by Claude Code (B4 + B5 integration, local E2E).

## Phase

Architecture v0.2 frozen (ADR-009 to ADR-018). Merged on `main`: B1, A1, A2/A2.2, B2 (offline scripts), A3 (web),
B3 (ingestion), **B4 (queue, worker, reconciler)**, **B5 (Redis limits, quotas, metrics cache)**. HEAD: `git log -1`.
No cloud resource exists. Nothing pushed (no remote). The local MVP works end to end on emulators.

## Milestones

| ID | Gate | Status |
|---|---|---|
| M1 | A1 + B1 merged, CI green | merged; CI never run (no remote) |
| M2 | C1–C9 verified, skeleton deployed | **C1–C9 NOT RUN (owner)** |
| M3 | B3 on emulator | done (suite re-run on merged tree) |
| M4 | B4 COMPLETED end to end | **local: done**; cloud: not run |
| M5 | B5 Redis with fallbacks | code merged; **real Redis NOT RUN**; cloud deploy pending |
| M6 | B6 baseline/spike/Redis on-off, 3 reps | **local done** (`tests/load`, 3 reps, lost=0); real Redis and k6 NOT RUN |
| M7 | README EN/TR with measured results | todo |

## Checks on main (clean clone, frozen lockfile, 2026-10-20)

- lint, typecheck, build: **pass**. `pnpm test`: 546 node tests / 26 files, 35 web jsdom, 31 infra offline: **pass**.
- Emulator integration (B3 API 14, B4 worker T1–T13 + races, services): 47 pass. Redis tests: **fail ECONNREFUSED, not run** (no Redis here).
- Web ApiClient -> built API smoke 2/2 and built-worker startup smoke 3 assertions: pass.
- Local E2E (`docs/verification/e2e-local.mjs`, real API + worker processes, emulators): 25/25 pass: ACCEPTED -> COMPLETED
  in <1 s, replay, 409 conflict, duplicate delivery harmless (attempts=1, duplicateDeliveries=1), cross-user 404,
  cross-tenant delivery inert, Redis unreachable -> enforced tenant `503 QUOTA_UNAVAILABLE` (header = body) and replay still works.
  Google sign-in is the Auth emulator's, **not real OAuth**.
- Local load probe (1 run, emulators, 20 dispatch/s local queue model, no Redis; NOT a benchmark): 20 rps x15 s: 300/300
  accepted and COMPLETED, create p95 52 ms, accept->COMPLETED p50 8.5 s (queue-rate bound). 100 rps x8 s spike: 358 accepted
  (all COMPLETED, 0 failed, 0 lost), 442 x `503` by admission control. Recovery 200/200.

## Blockers (owner actions)

1. Two orphan `java` Firestore emulators from this session hold ports 8080/9150 (PID 7604) and 18080/19150 (PID 12888);
   `emulators:exec` leaves one behind on Windows. Stop them: `Stop-Process -Id 7604,12888`. I was not permitted to.
2. No Redis locally (no redis-server, Memurai or Docker): the real-Redis suite (`tests/integration/redis.test.ts`, Lua) is untested until Linux CI.
3. GCP demo project, billing, region `europe-west1` approval (ADR-007); run C1–C9 via `infra/CLOUD_VERIFICATION.md`.
4. GitHub repository and remote (CI has never run), gcloud SDK, k6, Upstash account.
5. Approve (or reject) build scripts skipped by pnpm: `re2`, `@firebase/util` (nothing needs them).

## Known risks

- Cloud Tasks semantics behind ADR-003/011/017 are unverified until C1–C9; `CloudTasksQueue` uses Cloud Tasks v2 REST via
  `google-auth-library` (the `@google-cloud/tasks` SDK was not installed), also unverified live.
- Redis Lua scripts (burst, quota, release) never ran on real Redis. A syntax or semantics slip would fail closed (503) on enforced tenants.
- Codex's sandbox cannot spawn processes or commit on this machine: Claude runs all checks. Prefer Codex for writing, Claude for verifying.
- `scripts/integration.mjs` leaves an orphan emulator on Windows; CI (Linux) is unaffected.

## Next step

1. Owner: stop orphan emulators; approve GCP project + billing to run C1–C9; create the GitHub remote so CI can run (it includes real Redis).
2. B6 follow-ups: run `redis-on` variant once a Redis exists (`QP_LOAD_REDIS_URL`); optional k6 plan in `tests/load/README.md`. Infra test timeouts (flaky under load) need raising by the infra owner.
3. B7: deploy/shutdown scripts and README with measured numbers only.
