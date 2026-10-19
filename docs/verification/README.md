# Local verification scripts (Claude-owned, not part of CI)

Both scripts need: built artifacts (`pnpm build`), a Firestore emulator on `127.0.0.1:8080`, an Auth emulator on
`127.0.0.1:9099` (project `demo-queuepilot`), a worker and an API, **no Redis required**.

```
# worker (local queue pump + local worker auth, demo project only)
cd apps/worker && QP_ENV=test GCLOUD_PROJECT=demo-queuepilot FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 PORT=18281 QP_WORKER_URL=http://127.0.0.1:18281 \
  QP_QUEUE_ADAPTER=local QP_WORKER_AUTH_MODE=local node dist/server.js
# API (REDIS_URL deliberately points at a dead port to exercise the ADR-009 fail-closed path)
cd apps/api && QP_ENV=test GCLOUD_PROJECT=demo-queuepilot FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 PORT=18182 QP_WORKER_URL=http://127.0.0.1:18281 \
  QP_QUEUE_ADAPTER=local QP_REDIS_ENABLED=true REDIS_URL=redis://127.0.0.1:6390 node dist/server.js
node docs/verification/e2e-local.mjs     # 25 PASS/FAIL checks, exit 1 on any failure
node docs/verification/load-local.mjs    # baseline / spike / recovery probe
```

`e2e-local.mjs` talks to the real built API and worker over HTTP. The Auth emulator mints the ID token for a
`google.com` provider; **real Google OAuth is never exercised**. The Firestore emulator is not Firestore.
`load-local.mjs` is a probe, not a benchmark: one run, one Windows laptop, emulators, in-process `LocalDispatchQueue`
(20 dispatches/s model), no Redis. It says nothing about Cloud Run, Cloud Tasks or Upstash.

Run it against a fresh emulator; the scripts mutate the `sandbox` tenant (quota mode is restored to `none`).
