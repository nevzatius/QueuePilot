# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-19, by Claude Code (A2.2 / ADR-017 integration).

## Phase

Architecture v0.2 frozen with ADR-009 to ADR-017. Merged on `main`: B1 (tooling, CI), A1 (contracts),
A2 (pure domain) + A2.2 (ADR-017: dispatch is a wake-up; supersedes ADR-014), B2 (offline cloud scripts).
A2.2 code commit `f9fe0df` (cherry-pick of `46e871b`); docs commit follows it. HEAD: see `git log -1`. No cloud resource exists. Nothing pushed.
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

lint, typecheck, build: pass. Unit: 449 tests / 18 files pass (includes A2.2 race: 5040 interleavings; fuzz: 800 schedules).
Infra offline: 31 pass. Integration (emulator, ports free): 2/3 pass; Redis test fails ECONNREFUSED (no Redis).
Redis: **NOT PASSED**. C1-C9: **NOT RUN**.

## Blockers (owner actions)

1. (cleared) Port 8080 was free on 2026-10-19 and the Firestore/Auth emulator tests ran and passed.
2. No local Redis (no redis-server, Memurai or Docker). The Redis integration test cannot run here
   (`ECONNREFUSED 127.0.0.1:6379`, re-confirmed). Redis result: **NOT PASSED / not run**; relies on Linux CI.
3. GCP demo project, billing, Blaze, region `europe-west1` approval (ADR-007); run C1–C9 via `infra/CLOUD_VERIFICATION.md`.
4. GitHub repository and remote (CI has never run); gcloud SDK, k6, Upstash account.
5. Confirm the Codex model is available on the account.

## Known risks

- Cloud Tasks semantics behind ADR-003, ADR-011, ADR-017 are unverified until C1–C9. Since ADR-017 `getTask`
  is only a load hint, so contradictions cost extra tasks, not correctness. Extra-task and attention rates are unmeasured.
- `infra/` tests are not part of `pnpm test` or CI yet.
- pnpm ignored the `re2` build script; approve it only if B3/B5 needs it.

## Next step

Owner: clear blockers 1–2 (or confirm CI) and decide on C1–C9. Then A3 (Claude) and B3 (Codex) can start.
B3 is unaffected by A2.2 (domain-only). B4 must follow the ADR-017 adapter contract in TASKS B4 and ARCHITECTURE §6.
