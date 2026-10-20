# QueuePilot demo script (local emulator demonstration)

Audience: software engineers, architects, technical recruiters. Length: about 10 minutes.
**Label this clearly as a local emulator demonstration.** Sign-in uses the Firebase Auth *emulator's* Google provider, Firestore is the emulator,
the queue is an in-process model rate-limited to 20 dispatches/s, and nothing runs on Google Cloud. Real Google OAuth, Cloud Run, Cloud Tasks and Upstash have not been exercised.

## What is verified versus what is rehearsed

| Step | Backed by | Status |
|---|---|---|
| Accept → process → complete, replay, 409, duplicate delivery, cross-tenant/user isolation, Redis-down fail-closed | `docs/verification/e2e-local.mjs`, 25 checks against real built API + worker + emulators | verified 2026-10-20 (records in `docs/PROJECT_STATE.md`) |
| Quota, burst and fail-closed behaviour on real Redis | `tests/integration/redis*.test.ts`, `apps/api/test/integration/redis-quota.test.ts` | PASS in GitHub Actions (see the Actions tab) |
| Spike / recovery numbers | `tests/load/results/2026-10-20T10-19-00-417Z/REPORT.md` | local, 3 repetitions, emulators |
| Click-through in the React UI against the live local API | – | **not rehearsed by the maintainers yet**; do a dry run before presenting |

## Setup (before the audience arrives)

Follow the README "Local setup" and [docs/verification/README.md](verification/README.md): build, start the emulators, start the worker, start the API, then the web app
(`pnpm --filter @queuepilot/web dev`) pointed at the local API and Auth emulator via the `VITE_*` variables in `apps/web/src/config.ts`.
If the UI wiring is not ready, run the script-driven version (`node docs/verification/e2e-local.mjs`) and narrate its output; it covers the same flow.

## Story (10 steps)

1. **Problem.** Bursty service requests: accept fast, never lose work, never process harmfully twice, protect shared capacity.
2. **Sign in** with Google (emulator). One slide on membership: tenant and role come from Firestore, not token claims.
3. **Submit a request.** Show `202 Accepted`: the response means the request is *committed in Firestore*, not yet processed (invariant I1).
4. **Observe `ACCEPTED`** (or the derived `QUEUED`) in the dashboard.
5. **Observe `PROCESSING`**: the worker took a lease (60 s) in a transaction; mention fencing, only the lease holder can finish.
6. **Observe `COMPLETED`** and open the **event timeline**: ACCEPTED, lease, completion. Triage output is deterministic for a given input and rules version.
7. **View metrics** (counts by status, backlog, stuck/attention counters; cached 5 s).
8. **Idempotent replay.** Send the same `Idempotency-Key` and body again: same `requestId`, `Idempotent-Replayed: true`, no second charge to the quota. Change the body: `409`.
9. **Controlled overload.** Explain, then show the local spike result: at 100 req/s against a 40 req/s per-instance admission limit, about 353 of 800 were accepted, **all** accepted ones completed, the rest were shed with `503 OVERLOADED` and `Retry-After`. Say plainly that this is a laptop with emulators. Contrast with Redis quotas: over-budget users get `429`, and if Redis is down enforced tenants get `503 QUOTA_UNAVAILABLE` (fail closed) while replays still work.
10. **Show the proof.** GitHub Actions run on `main`: lint, typecheck, unit, web, infrastructure, emulator integration, real-Redis integration, smoke. Then the honest limits slide below.

## Reliability talking points (keep brief)

- Delivery is **at-least-once with application guards**; exactly-once is not claimed.
- ADR-017: a Cloud Tasks task is only a wake-up; Firestore decides. The reconciler re-dispatches lost work; if it is down, requests stay durable and visible as stuck.
- Redis never holds business state. Losing it degrades rate limiting and fails quotas closed; it cannot lose or duplicate requests.
- Failure injection: duplicate delivery, lease takeover, lost enqueue are covered by domain race/fuzz tests and worker tests T1–T13 on a modelled queue.

## Limits slide (say these out loud)

Not deployed. C1–C9 cloud checks not run. No production-readiness, cloud scalability or security-certification claim. No real-Redis load benchmark. Local numbers only.
