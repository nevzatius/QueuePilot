# Local load suite (B6)

Reproducible **local** performance runs for QueuePilot: Firebase Auth + Firestore emulators, one built worker, one built API,
all on one machine. Nothing here touches the cloud, and nothing here is comparable with Cloud Run, Cloud Tasks or Upstash.

```
pnpm build                                   # the suite runs apps/*/dist
node tests/load/run.mjs                      # all scenarios, 3 repetitions each (~15 min)
node tests/load/run.mjs --quick --reps 1     # shortened smoke run (not for reporting)
node tests/load/run.mjs --only spike         # comma-separated scenario names
QP_LOAD_REDIS_URL=redis://127.0.0.1:6379 node tests/load/run.mjs   # also runs the redis-on variant
```

The runner starts and stops the emulators and both services itself (needs ports 8080, 9099, 18182, 18281 free, and Java for the
emulators). Each repetition wipes Firestore, re-seeds the `sandbox` tenant (quotaMode `none`, high limits) and restarts API and worker.
Output goes to `tests/load/results/<timestamp>/`: `raw.json` (every run, including backlog samples) and `REPORT.md`.

## Scenarios

| name | load | what it separates |
|---|---|---|
| `baseline` | 20 req/s x 15 s open loop, 20 users | steady state below admission (40/s) and below the local queue rate (20/s) |
| `spike` | 100 req/s x 8 s | **API admission**: excess becomes `503 OVERLOADED`; accepted work must all complete (lost = 0) |
| `recovery` | 20/s x 8 s, 100/s x 8 s, 10/s x 25 s | backlog (accepted, not terminal) sampled each ~1 s; recovery = seconds after spike end until outstanding <= 10 |
| `worker-throughput` | API enqueue faulted (`QP_FAULT_CREATE=fail`), wake-ups POSTed directly to the worker at concurrency 1 / 8 / 32 | **worker + Firestore emulator**, without the 20/s local queue and without admission |

Variants: `redis-off` (`QP_REDIS_ENABLED=false`), `redis-unreachable` (enabled, dead port: the degraded path), `redis-on` (only if a
real Redis answers on `QP_LOAD_REDIS_URL`; otherwise the report says NOT RUN). `redis-unreachable` is not "Redis on".

## Reading the numbers

- Local dispatch is `LocalDispatchQueue`: **20 dispatches/s** fixed in `packages/core`, so every end-to-end accepted -> COMPLETED figure
  is bounded by that model. It is not a worker limit; `worker-throughput` is the worker-side figure.
- Load client and servers share one machine and one CPU budget, so client-side latency includes contention.
- Accepted -> COMPLETED is observed by polling (about 0.5-1 s resolution).
- Open loop: arrivals follow the wall clock and never wait for responses.

## Optional k6 plan (k6 is not installed here, nothing below was run)

Use `constant-arrival-rate` executors against the same local stack, started the way `docs/verification/README.md` describes:
`baseline` = 20 rps for 15 s (preAllocatedVUs 50), `spike` = 100 rps for 8 s (preAllocatedVUs 200). Tokens: pre-mint 20 Auth-emulator
ID tokens in `setup()`, send `Idempotency-Key: ${uuid}` per iteration, tag `status` and `problem.code` for rejection splits, and use
thresholds only as regression guards (for example `http_req_duration{expected_response:true} p(95)<250`, taken from a measured
local baseline, never from a target). Completion/backlog still needs the polling tracker, so keep Node as the source of truth.
