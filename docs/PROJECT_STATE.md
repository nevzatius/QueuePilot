# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-19, by Claude Code (A0).

## Phase

Architecture v0.2 is frozen, with corrections ADR-009 to ADR-013. A0 is done.
**Awaiting the owner's implementation approval.** No application code exists yet.

## Milestones

| ID | Target | Gate | Status |
|---|---|---|---|
| M1 | Tue 12:00 | A1 and B1 merged, CI green | todo |
| M2 | Tue 19:00 | C1–C9 verified. Skeleton deployed (Hosting, login, /health, private worker). Indexes, TTL and rules deployed. A2 merged | todo |
| M3 | Wed 14:00 | B3: bootstrap and idempotent POST/GET on the emulator. Integration tests green in CI | todo |
| M4 | Wed 21:00 | B4: end-to-end COMPLETED in the cloud. T1–T13 green. Web login, submit and list running locally | todo |
| M5 | Thu 13:00 | B5: Redis with fallbacks. Web detail and metrics. Cloud deploy up to date | todo |
| M6 | Thu 21:00 | B6: baseline, spike and Redis on/off measured (3 repetitions) | todo |
| M7 | Fri 12:00 | README EN/TR with measured results. Final review. Shutdown tested | todo |
| Freeze | Fri 15:00 | Bug fixes and demo rehearsal only | – |

## In progress

_(none)_

## Blockers (owner actions)

1. GCP demo project, billing account, Blaze plan, region confirmation (`europe-west1`, ADR-007).
2. GitHub repository creation and visibility. `git init` has not been run yet.
3. Local tools: gcloud SDK, firebase-tools, k6, Memurai (or an Upstash dev database).
4. Upstash account and confirmation that a GCP `europe-west1` region is available.
5. Confirm that the Codex model (`gpt-6.1-sol` appears in the local config) is available on the account.

## Known risks

- No local Docker or WSL. Heavy integration tests rely on Linux CI runners.
- The Cloud Tasks semantics behind ADR-003 and ADR-011 are unverified until B2 (C1–C9).

## Next step

Once approved: A1 (Claude) and B1 (Codex) start in parallel on two branches.
