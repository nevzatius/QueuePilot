# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-19, by Claude Code (A3 + B3 integration).

## Phase

Architecture v0.2 frozen with ADR-009 to ADR-017. Merged on `main`: B1 (tooling, CI), A1 (contracts),
A2 (pure domain) + A2.2 (ADR-017: dispatch is a wake-up; supersedes ADR-014), B2 (offline cloud scripts).
A3 (web) and B3 (auth, ingestion API) merged. HEAD: see `git log -1`. No cloud resource exists. Nothing pushed.
Accepted requests stay ACCEPTED until B4 connects the queue (`deferredQueue`) and worker; B5 Redis adapters pending.

## Milestones

| ID | Target | Gate | Status |
|---|---|---|---|
| M1 | Tue 12:00 | A1 and B1 merged, CI green | merged; CI not yet run (no remote) |
| M2 | Tue 19:00 | C1–C9 verified. Skeleton deployed. Indexes, TTL and rules deployed. A2 merged | A2 merged; **C1–C9 and deploy pending (owner)** |
| M3 | Wed 14:00 | B3: bootstrap and idempotent POST/GET on the emulator. Integration tests green in CI | merged; emulator re-run on merged tree pending |
| M4 | Wed 21:00 | B4: end-to-end COMPLETED in the cloud. T1–T13 green. Web running locally | todo |
| M5 | Thu 13:00 | B5: Redis with fallbacks. Web detail and metrics. Cloud deploy current | todo |
| M6 | Thu 21:00 | B6: baseline, spike and Redis on/off measured (3 repetitions) | todo |
| M7 | Fri 12:00 | README EN/TR with measured results. Final review. Shutdown tested | todo |
| Freeze | Fri 15:00 | Bug fixes and demo rehearsal only | – |

## Checks on main (combined, local)

lint, typecheck, build: pass. `pnpm test`: 478 node tests / 19 files, 35 web jsdom tests / 4 files, 31 infra offline: all pass.
Emulator suites (B3 API 14 tests, frontend-to-API smoke): **NOT RUN on merged tree**; a leftover Firestore emulator
(java, port 8080, from an aborted run) blocks `emulators:exec` and was not killed without approval. B3 reported 14/14 on its branch.
Smoke (web ApiClient -> built API -> emulators) is written, uses an Auth-emulator token; real Google sign-in is never exercised.
Redis: **NOT PASSED** (no Redis available, ECONNREFUSED). C1-C9: **NOT RUN**.

## Blockers (owner actions)

1. Free port 8080 (orphan java Firestore emulator) and run `pnpm test:integration`; Redis test will still fail locally.
2. No local Redis (no redis-server, Memurai or Docker). The Redis integration test cannot run here
   (`ECONNREFUSED 127.0.0.1:6379`, re-confirmed). Redis result: **NOT PASSED / not run**; relies on Linux CI.
3. GCP demo project, billing, Blaze, region `europe-west1` approval (ADR-007); run C1–C9 via `infra/CLOUD_VERIFICATION.md`.
4. GitHub repository and remote (CI has never run); gcloud SDK, k6, Upstash account.
5. Confirm the Codex model is available on the account.

## Known risks

- Cloud Tasks semantics behind ADR-003, ADR-011, ADR-017 are unverified until C1–C9. Since ADR-017 `getTask`
  is only a load hint, so contradictions cost extra tasks, not correctness. Extra-task and attention rates are unmeasured.
- pnpm skips build scripts for `re2` (firebase-tools dev-only, optional native) and `@firebase/util` (postinstall only writes default config); neither approved, nothing needs them.
- Web calls `/api/...` same-origin (Hosting rewrite, no CORS). Local dev needs a Vite proxy or Hosting emulator.

## Next step

Owner: free port 8080, run `pnpm test:integration` (Redis needs CI). Then B4 (queue, worker, reconciler; ADR-017) and B5 (Redis) can start.
