# Project State

Single writer: Claude Code (ADR-013). Keep this file under 60 lines.
Last updated: 2026-10-23, by Claude Code (B9-7 and its review fixes merged as PR #8 and #9; B9-9 live results and scheduler ticks in PR #11 and #13; B9-9c stale claims; Postman API checks done 2026-10-26, see TASKS).

## Phase

Architecture v0.2 frozen (ADR-009 to ADR-018), plus ADR-019 (free-tier platform, amended 2026-10-22). `main` (see git log): B1-B6, B7 and B9-0 to B9-4, B9-6, B9-7 (with review fixes) are in.
Remote: public `github.com/nevzatius/QueuePilot`. Free-tier cloud resources exist since the first live run (2026-10-22/23): Firebase Spark project, two Render free services, Upstash QStash schedule and Redis. No Google Cloud (billed) resource exists. The local MVP also works end to end on emulators.
The project runs without a billing account, so the target is free tiers only (Firebase Spark, Render free, Upstash QStash + Redis `queuepilot`). Cloud Tasks stays supported behind the queue factory. Owner runbook: `docs/DEPLOYMENT_RUNBOOK.md` ("Free-tier path" first, GCP path after it).

## Milestones

| ID | Gate | Status |
|---|---|---|
| M1 | A1 + B1 merged, CI green | **done** |
| M2 | C1-C9 verified, skeleton deployed | **C1-C9 NOT RUN** (GCP path needs billing; free path replaces it in B9-9) |
| M3 | B3 on emulator | done |
| M4 | B4 COMPLETED end to end | **local: done**; cloud: one free-tier run reached COMPLETED (B9-9, n=1); GCP path not run |
| M5 | B5 Redis with fallbacks | **real-Redis suites PASS in CI**; Upstash Redis was used by the live run (rate-limit/quota path worked end to end, inferred from a completed request; no load test) |
| M6 | B6 baseline/spike/Redis on-off, 3 reps | **local done** (`tests/load`); real-Redis load and k6 NOT RUN |
| M7 | README EN/TR with measured results | **done**; numbers are local and labelled so |

## B9 plan (ADR-019)

Merged: B9-1 config/production guard/factory, B9-2 `QStashQueue`, B9-3 worker QStash verifier, B9-4 CORS + `TRUST_PROXY_HOPS` + Redis connect timeout, B9-6 web.
**B9-5 is only partly done**: the Redis connect timeout landed in B9-4; `count()` stuck counts, the time-based reconcile throttle (also for `/internal/reconcile`) and `RESOURCE_EXHAUSTED` classification are open (TASKS "B9-5 must").
B9-7 merged (PR #8): `render.yaml`, `firebase.json`, QStash setup/shutdown scripts, `preflight --profile free`, `seed-demo --profile free`, `QP_FIREBASE_SERVICE_ACCOUNT_JSON`, runbook free-tier section (covers the B9-8 runbook acceptance).
B9-7 review fixes (merged, PR #9): free indexes file without TTL, `RENDER` requires the service-account key, QStash timeout never claimed current, `<n><s|m|h>` timeouts, Hosting cache headers, `autoDeployTrigger: off`, runbook prerequisites and shutdown, nested log redaction.
B9-9: the first live free-tier deployment is done (2026-10-22/23); results in TASKS.md "B9-9 live results". Still open: shutdown (runbook step 11), the NOT VERIFIED live checks (Upstash-Timeout maximum, key rotation, Redis cold AUTH, QStash retry limits, Hosting header precedence, foreign-origin request) and the client-IP log follow-up.

## Checks

B9-7 review-fix branch, 2026-10-22: lint, typecheck, test, build and `preflight --profile free` (no FAIL). Images are smoke-run in CI only. The live run against Render, Firebase and Upstash is recorded in TASKS.md ("B9-9 live results"); its figures are one run each.

## Blockers (owner actions)

1. DONE (2026-10-22/23): accounts without a card, Firebase project (Spark), Render, Upstash (QStash + Redis), gcloud CLI.
2. Google provider enabled (DONE). **The long-lived service-account key still exists and must be deleted at shutdown** (runbook step 11).
3. License choice: none added.
4. Orphan `java` Firestore emulators may still hold local ports (8080/9150/18381); agents do not stop processes. Untracked `PROJECT_CONTEXT.md` is not committed.
5. pnpm build scripts `re2` and `@firebase/util` stay unapproved (images do not need them).

## Known risks

- Observed working in one run (n=1): Blueprint deploy, Google sign-in from Hosting, CORS call, API -> QStash -> worker -> Firestore to COMPLETED, QStash schedule script. `CloudTasksQueue` (v2 REST) is unverified live.
- NOT VERIFIED: whether retries count toward the 1,000/day QStash limit, Hosting header precedence, `Upstash-Timeout` maximum, key rotation, Redis cold AUTH, the live client IP behind Render (spoofed `X-Forwarded-For` only PARTLY VERIFIED).
- Without the B9-5 remainder, replayed QStash tokens can cost Firestore reads until `exp` + 30 s; Spark quotas (50K reads, 20K writes per day) shut the product off when exceeded.
- Avoid concurrent sessions on one checkout. `pnpm deploy` fails on Windows across drives; `scripts/integration.mjs` leaves orphan emulators on Windows.

## Open follow-ups from the B7 review

F2, F3, F7, N1 (descriptions are in the B7 review report, not in the repo; to be written into TASKS.md when triaged), and T1-T5:
T3 `.claude/agents/architecture-reviewer.md` is stale against ADR-017; T4 stale READMEs and TASKS notes; T5 metrics stuck-read cost (relevant to B9-5). T1, T2 per the review report.

## Next step

1. The B9-5 remainder (`count()` stuck counts, time-based reconcile throttle also for `/internal/reconcile`, `RESOURCE_EXHAUSTED` classification) stays open: it protects the Spark read budget and is a prerequisite before any feature that adds polling or reads (planned B11). 2. Owner: close the open B9-9 live checks, then shut down (runbook step 11) when the demo is no longer needed.
3. Planned, not scheduled: ADR-020 (webhook demo job) and TASKS "B10-B13". B13a README first screen, `docs/USE_CASES.md` and the live `docs/DEMO.md` script are in the docs PR "README refresh, use cases and live demo script"; B13b is open.
