# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-21, by Claude Code (B9-2: `QStashQueue` + local qstash profile, branch `claude/b9-2-qstash-adapter`, PR open).

## Phase

Architecture v0.2 frozen (ADR-009 to ADR-018), plus ADR-019 (free-tier platform). `main` = `ac6bc2b`: B1-B6 and B7 (PR #1, merged) are in.
Remote: private `github.com/nevzatius/QueuePilot`. No cloud resource exists. The local MVP works end to end on emulators.
B8 analysis done. B8.5 spike done (disposable repo `nevzatius/render-qstash-spike`, `402c284`, service deleted).
The owner has no billing account, so the target is free tiers only: Firebase Spark + Render free + Upstash QStash + Upstash Redis `queuepilot`.
Cloud Tasks stays supported behind the queue factory. Owner runbook: `docs/DEPLOYMENT_RUNBOOK.md` (GCP path; free path comes in B9-8).

## Milestones

| ID | Gate | Status |
|---|---|---|
| M1 | A1 + B1 merged, CI green | **done** |
| M2 | C1-C9 verified, skeleton deployed | **C1-C9 NOT RUN** (GCP path needs billing; free path replaces it in B9-9) |
| M3 | B3 on emulator | done |
| M4 | B4 COMPLETED end to end | **local: done**; cloud: not run |
| M5 | B5 Redis with fallbacks | **real-Redis suites PASS in CI**; Upstash not run |
| M6 | B6 baseline/spike/Redis on-off, 3 reps | **local done** (`tests/load`); real-Redis load and k6 NOT RUN |
| M7 | README EN/TR with measured results | **done**; numbers are local and labelled so |

## B9 plan (ADR-019)

B9-1 config/production guard/adapter factory. B9-2 `QStashQueue` + `LocalDispatchQueue` QStash profile. B9-3 worker QStash signature verifier, `Retry-After` on 409/503.
B9-4 CORS allowlist, trustProxy (`TRUST_PROXY_HOPS=3`) with spoofing test. B9-5 Firestore read budget (`count()`, throttled reconcile, `RESOURCE_EXHAUSTED`, Redis connect timeout).
B9-6 web: cross-origin API URL, 30 s polling, "service waking up". B9-7 `render.yaml`, `firebase.json`, QStash setup/shutdown scripts, preflight free profile, seed-demo limit.
B9-8 runbook + state. B9-9 owner manual setup and live verification.

## Checks

Last full run (2026-10-20, B7 branch, now merged): lint, typecheck, build, 551 node + 35 web + 59 node:test pass; images smoke-run in CI only. B9-0 is docs only.

## Blockers (owner actions)

1. Accounts, no card: Firebase project (Spark; Firestore `europe-west1` is irreversible), Render, Upstash (QStash + new Redis `queuepilot`), install gcloud CLI.
2. Firebase Google provider and authorized domains.
3. License choice: none added.
4. Orphan `java` Firestore emulators may still hold local ports (8080/9150/18381); agents do not stop processes. Untracked `PROJECT_CONTEXT.md` is not committed.
5. pnpm build scripts `re2` and `@firebase/util` stay unapproved (images do not need them).

## Known risks

- QStash and Render free behaviour is measured only in the spike (ADR-019 Evidence, mostly n=1). Whether retries count toward the 1,000/day message limit is unverified.
- `QStashQueue`, Cloud Tasks semantics and `CloudTasksQueue` (v2 REST) are unverified live.
- Redis client timeouts are 100 ms; Upstash cold connect was about 404 ms (B9-5).
- Spark quotas (50K reads, 20K writes per day) shut the product off when exceeded.
- Avoid concurrent sessions on one checkout. `pnpm deploy` fails on Windows across drives; `scripts/integration.mjs` leaves orphan emulators on Windows.

## Open follow-ups from the B7 review

F2, F3, F7, N1 (descriptions are in the B7 review report, not in the repo; to be written into TASKS.md when triaged), and T1-T5:
T3 `.claude/agents/architecture-reviewer.md` is stale against ADR-017; T4 stale READMEs and TASKS notes; T5 metrics stuck-read cost (relevant to B9-5). T1, T2 per the review report.

## Next step

1. Review and merge the B9-2 PR (B9-0, B9-1 are merged). 2. Start B9-3 (worker QStash signature verifier, `Retry-After`). 3. Owner: create the accounts in Blockers 1-2 in parallel. B9-2 live checks are listed in TASKS.md (B9 follow-ups).
