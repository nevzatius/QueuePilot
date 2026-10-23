# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-22, by Claude Code (B9-7 merged as PR #8; B9-7 review fixes on `claude/b9-7-review-fixes`, PR open).

## Phase

Architecture v0.2 frozen (ADR-009 to ADR-018), plus ADR-019 (free-tier platform, amended 2026-10-22). `main` = `2273e73`: B1-B6, B7 and B9-0 to B9-4, B9-6, B9-7 are in.
Remote: private `github.com/nevzatius/QueuePilot`. No cloud resource exists. The local MVP works end to end on emulators.
The owner has no billing account, so the target is free tiers only: Firebase Spark + Render free + Upstash QStash + Upstash Redis `queuepilot`.
Cloud Tasks stays supported behind the queue factory. Owner runbook: `docs/DEPLOYMENT_RUNBOOK.md` ("Free-tier path" first, GCP path after it).

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

Merged: B9-1 config/production guard/factory, B9-2 `QStashQueue`, B9-3 worker QStash verifier, B9-4 CORS + `TRUST_PROXY_HOPS` + Redis connect timeout, B9-6 web.
**B9-5 is only partly done**: the Redis connect timeout landed in B9-4; `count()` stuck counts, the time-based reconcile throttle (also for `/internal/reconcile`) and `RESOURCE_EXHAUSTED` classification are open (TASKS "B9-5 must").
B9-7 merged (PR #8): `render.yaml`, `firebase.json`, QStash setup/shutdown scripts, `preflight --profile free`, `seed-demo --profile free`, `QP_FIREBASE_SERVICE_ACCOUNT_JSON`, runbook free-tier section (covers the B9-8 runbook acceptance).
B9-7 review fixes (open PR): free indexes file without TTL, `RENDER` requires the service-account key, QStash timeout never claimed current, `<n><s|m|h>` timeouts, Hosting cache headers, `autoDeployTrigger: off`, runbook prerequisites and shutdown, nested log redaction.
B9-9: the first live free-tier deployment is done (2026-10-22/23); results in TASKS.md "B9-9 live results". Still open: shutdown (runbook step 11), the NOT VERIFIED live checks (Upstash-Timeout maximum, key rotation, Redis cold AUTH, QStash retry limits, Hosting header precedence, foreign-origin request) and the client-IP log follow-up.

## Checks

B9-7 review-fix branch, 2026-10-22: lint, typecheck, test, build and `preflight --profile free` (no FAIL); results in the PR. The services emulator test ran locally. Images are smoke-run in CI only. Nothing was run against Render, Firebase or Upstash.

## Blockers (owner actions)

1. Accounts, no card: Firebase project (Spark; Firestore `europe-west1` is irreversible), Render, Upstash (QStash + new Redis `queuepilot`), install gcloud CLI. Follow the runbook; stop at any card prompt.
2. Firebase Google provider; service-account key (long-lived, delete at shutdown).
3. License choice: none added.
4. Orphan `java` Firestore emulators may still hold local ports (8080/9150/18381); agents do not stop processes. Untracked `PROJECT_CONTEXT.md` is not committed.
5. pnpm build scripts `re2` and `@firebase/util` stay unapproved (images do not need them).

## Known risks

- QStash and Render free behaviour is measured only in the spike (ADR-019 Evidence, mostly n=1). Whether retries count toward the 1,000/day message limit is unverified.
- `QStashQueue`, the QStash schedule scripts (API shapes from memory), Render Blueprint, Firebase Hosting on Spark and `CloudTasksQueue` (v2 REST) are unverified live.
- Without the B9-5 remainder, replayed QStash tokens can cost Firestore reads until `exp` + 30 s; Spark quotas (50K reads, 20K writes per day) shut the product off when exceeded.
- Avoid concurrent sessions on one checkout. `pnpm deploy` fails on Windows across drives; `scripts/integration.mjs` leaves orphan emulators on Windows.

## Open follow-ups from the B7 review

F2, F3, F7, N1 (descriptions are in the B7 review report, not in the repo; to be written into TASKS.md when triaged), and T1-T5:
T3 `.claude/agents/architecture-reviewer.md` is stale against ADR-017; T4 stale READMEs and TASKS notes; T5 metrics stuck-read cost (relevant to B9-5). T1, T2 per the review report.

## Next step

1. Review and merge the B9-7 review-fix PR. 2. Decide whether to finish the B9-5 remainder before the live run (recommended: it protects the Spark read budget). 3. Owner: close the open B9-9 live checks, then shut down (runbook step 11) when the demo is no longer needed.
