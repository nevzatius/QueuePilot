# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-19, by Claude Code (A2 + B2 integration).

## Phase

Architecture v0.2 frozen with ADR-009 to ADR-016. Merged on `main`: B1 (tooling, CI), A1 (contracts),
A2 (pure domain), B2 (offline cloud scripts). No cloud resource exists. Nothing pushed.
Next work packages (A3 web, B3 platform) are not started.

## Milestones

| ID | Target | Gate | Status |
|---|---|---|---|
| M1 | Tue 12:00 | A1 and B1 merged, CI green | merged; CI not yet run (no remote) |
| M2 | Tue 19:00 | C1–C9 verified. Skeleton deployed. Indexes, TTL and rules deployed. A2 merged | A2 merged; **C1–C9 and deploy pending (owner)** |
| M3 | Wed 14:00 | B3: bootstrap and idempotent POST/GET on the emulator. Integration tests green in CI | todo |
| M4 | Wed 21:00 | B4: end-to-end COMPLETED in the cloud. T1–T13 green. Web running locally | todo |
| M5 | Thu 13:00 | B5: Redis with fallbacks. Web detail and metrics. Cloud deploy current | todo |
| M6 | Thu 21:00 | B6: baseline, spike and Redis on/off measured (3 repetitions) | todo |
| M7 | Fri 12:00 | README EN/TR with measured results. Final review. Shutdown tested | todo |
| Freeze | Fri 15:00 | Bug fixes and demo rehearsal only | – |

## Checks on main (combined, local)

lint, typecheck, build: pass. Unit: 449 tests / 18 files pass. Infra offline: 31 pass.
Integration (`pnpm test:integration`): **not run in this integration**, see blockers 1 and 2.

## Blockers (owner actions)

1. Port 8080 is held by a stale Firestore emulator (java, PID 26384, `demo-queuepilot`, started 2026-10-19 20:27).
   Stop it, then re-run `corepack pnpm test:integration`. Emulator tests passed 2/3 on the B2 branch.
2. No local Redis (no redis-server, Memurai or Docker). The Redis integration test cannot run here
   (B2 reported `ECONNREFUSED 127.0.0.1:6379`). Redis result: **NOT PASSED / not run**; relies on Linux CI.
3. GCP demo project, billing, Blaze, region `europe-west1` approval (ADR-007); run C1–C9 via `infra/CLOUD_VERIFICATION.md`.
4. GitHub repository and remote (CI has never run); gcloud SDK, k6, Upstash account.
5. Confirm the Codex model is available on the account.

## Known risks

- Cloud Tasks semantics behind ADR-003, ADR-011, ADR-014 are unverified until C1–C9. Domain assumes
  getTask reflects createTask immediately and that completed tasks answer NOT_FOUND.
- `infra/` tests are not part of `pnpm test` or CI yet.
- pnpm ignored the `re2` build script; approve it only if B3/B5 needs it.

## Next step

Owner: clear blockers 1–2 (or confirm CI) and decide on C1–C9. Then A3 (Claude) and B3 (Codex) can start.
B3 must use the reconciler adapter flow in ARCHITECTURE §6.
