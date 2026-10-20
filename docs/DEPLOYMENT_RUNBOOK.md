# B7 owner runbook: controlled Google Cloud deployment

Status: **prepared offline (2026-10-20, extended by the B7 pre-deployment hardening). Nothing here has been run against Google Cloud.**
No Google Cloud project, billing, resource or credential was touched, and C1–C9 are all **NOT RUN**. Every command below is executed by the **owner**, after reviewing the plan it prints.
Agents do not deploy. Source of truth for behaviour: [infra/README.md](../infra/README.md),
[infra/CLOUD_VERIFICATION.md](../infra/CLOUD_VERIFICATION.md), [ARCHITECTURE §14](ARCHITECTURE.md), ADR-007/011/016.

Command provenance: commands marked **[repo]** are implemented by scripts in this repository and covered by offline tests.
Commands marked **[docker]** and **[gcloud]** are standard Docker, gcloud or Firebase CLI operations that the repository documents in prose but does not script;
check them with `--help` before running. Placeholders in `CAPITALS` are yours to fill in; none is invented here.

## 0. Blockers that cannot be solved by commands

1. **Images are defined but not built or pushed by anything automated.** `apps/api/Dockerfile` and `apps/worker/Dockerfile` exist (section F).
   CI builds both on every push and smoke-runs them, without pushing. Docker is not installed on the development machine, so no image was built locally;
   the owner builds, pushes and records the `sha256` digests. Nothing in the repository logs in to a registry or pushes.
2. **C1–C9 gate ADR-003/011/017 assumptions.** Run them (section D) before treating cloud behaviour as verified.
3. **Admin and demo data exist only as scripts that have never touched a real project:** `scripts/grant-role.mjs` and `scripts/seed-demo.mjs` (section G) were tested
   offline and against the Firestore emulator only.
4. **Owner decisions:** the demo project, billing, the irreversible Firestore region (section C), the Redis provider, and a license.

## Pre-flight (local, no cloud access)

```powershell
node scripts/preflight.mjs --config D:/QueuePilot-local/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1
```

Reports `PASS` (verified locally), `FAIL` (repository inconsistency), `BLOCKED` (a local tool, artifact or configuration is missing) and `NOT RUN`
(external verification). It reads files and only the *names* of environment variables, never calls Google Cloud, and never prints values.
A green preflight does not mean any cloud resource exists or that C1–C9 passed. `--strict` also fails on `BLOCKED`; `--json` prints machine-readable output.

## A. Google Cloud project

1. Choose or create a dedicated **demo** project containing no production resources. Label it `queuepilot-environment=demo`.
   The scripts check this label and the exact project number before any write and refuse placeholder or `prod`-named projects.
2. Link billing yourself (the scripts never enable billing). Create a **budget with alerts** in the console first (Billing → Budgets).
   Instance and queue limits bound throughput, not money; they are not a hard cap.
3. Install gcloud yourself and log in with your normal short-lived login. Scripts take a short-lived token through gcloud and
   never persist or print it. No service-account keys are created.
4. Review organisation policies (public API access, service-account impersonation) and inherited IAM.
5. Region is fixed to `europe-west1` (ADR-007); the scripts reject any other region.
6. Copy `infra/config.example.json` **outside the repository** (for example `D:/QueuePilot-local/cloud.json`) and set
   `projectId`, `projectNumber`, `redisSecretVersion` (a numeric pinned version) and, later, the two image digests. The config accepts
   only these keys; credentials and fault flags are rejected.
7. Print the plan; this uses no credentials or network **[repo]**:

```powershell
node infra/apply.mjs --config D:/QueuePilot-local/cloud.json
```

Services enabled by the `bootstrap` stage: Resource Manager, Run, Tasks, Scheduler, Firestore, Firebase Rules, Secret Manager, IAM,
IAM Credentials, Artifact Registry.

```powershell
node infra/apply.mjs --config D:/QueuePilot-local/cloud.json --stage bootstrap --apply --approve-project=ACTUAL_DEMO_PROJECT
```

Stages run in this order, one at a time, each reviewed: `bootstrap`, (owner secret/image gate), `data`, `queue`, `access`, `deploy`, `iam`, `scheduler`.
`--stage all` is refused.

**Guarded wrapper (recommended) [repo].** `scripts/deploy.mjs` is a front end for exactly one stage. Without `--apply` it prints a readable plan, warnings
(for example the irreversible Firestore location or the public API grant) and a *plan digest*, and uses no credentials or network. To apply, repeat the project,
the region and the digest you reviewed; it then delegates to `infra/apply.mjs`, whose own checks (project number, `queuepilot-environment=demo` label, Firestore
location consent, paused queue/job, pinned images) stay in force. The wrapper never resumes a queue or job.

```powershell
node scripts/deploy.mjs --config D:/QueuePilot-local/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1 --stage bootstrap
node scripts/deploy.mjs --config D:/QueuePilot-local/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1 --stage bootstrap `
  --apply --approve-project ACTUAL_DEMO_PROJECT --approve-region europe-west1 --approve-plan DIGEST_FROM_THE_PLAN
```

Extra approvals: `data` needs `--approve-firestore-location europe-west1`; `iam` needs `--approve-public-api` (it makes `qp-api` publicly invocable); `scheduler` creates
the job only with `--approve-b4-worker-image FULL_PINNED_WORKER_IMAGE`. Only `europe-west1` is accepted. Exit codes: 0 ok, 2 usage, 3 refused, 4 state conflict, 5 I/O.
The direct `infra/apply.mjs` commands below remain valid and equivalent.

## B. IAM (created by `bootstrap` and `access`; summary of ARCHITECTURE §14)

| Principal | Scope | Grant |
|---|---|---|
| `qp-api-sa` | project / queue `qp-process` / `qp-tasks-invoker-sa` / secret `redis-url` | `datastore.user` / custom `qpEnqueuer` (`tasks.create`) / `serviceAccountUser` / `secretAccessor` |
| `qp-worker-sa` | same scopes | `datastore.user` / custom `qpReconciler` (`tasks.create`, `tasks.get`) / `serviceAccountUser` / `secretAccessor` |
| `qp-tasks-invoker-sa`, `qp-scheduler-sa` | `qp-worker` only | `run.invoker` (the **OIDC identities** Cloud Tasks and Scheduler use) |
| `allUsers` | `qp-api` only | `run.invoker` (auth is in the app; needed by the Hosting rewrite). An org policy may block this; the script will not bypass it |
| Cloud Tasks / Scheduler service agents | project; Tasks also on `qp-tasks-invoker-sa` | `cloudtasks.serviceAgent` / `cloudscheduler.serviceAgent`; `serviceAccountUser` |

OIDC audience for both Tasks and Scheduler is the exact worker origin `https://qp-worker-PROJECT_NUMBER.europe-west1.run.app`.
Confirm it is listed in the deployed worker's URLs before activation. The worker must stay without public IAM bindings; `iam` aborts if it has any.
The provisioning identity (you) needs the permissions listed under "owner provisioner" in `infra/README.md`; use temporary or reviewed custom roles.

## C. Firestore (stage `data`)

- **Irreversible decision:** region `europe-west1` for the default Native database. Creation requires **both** flags **[repo]**:

```powershell
node infra/apply.mjs --config D:/QueuePilot-local/cloud.json --stage data --apply --approve-project=ACTUAL_DEMO_PROJECT --approve-firestore-location=europe-west1
```

- Creates the database with delete protection if absent, installs deny-all rules, three composite indexes (`infra/firestore.indexes.json`),
  single-field exemptions and TTL policies on `expiresAt` for requests, events and idempotency keys. An existing database in a
  different region/type stops the script; nothing is migrated or deleted.
- Index and TTL operations report **PENDING**. Re-run the same command until composites read `READY` and TTL reads `ACTIVE`. A completed
  operation alone does not prove readiness. Do not send traffic before then.
- TTL deletion is asynchronous and does not cascade to subcollections. "TTL active" and "expired disposable records actually deleted" are two separate checks, both NOT RUN.

## D. Cloud Tasks, Scheduler and the C1–C9 checks

Queue `qp-process` (stage `queue`) **[repo]**: `maxDispatchesPerSecond=20`, `maxConcurrentDispatches=30`, `maxAttempts=10`,
`maxRetryDuration=600s`, `minBackoff=2s`, `maxBackoff=60s`, `maxDoublings=4`. New and existing queues are **paused** and read back as `PAUSED`
(there is a brief create-to-pause window, so do not enqueue concurrently). OIDC identity and `dispatchDeadline=30s` are set per task by the API, not on the queue.

```powershell
node infra/apply.mjs --config D:/QueuePilot-local/cloud.json --stage queue --apply --approve-project=ACTUAL_DEMO_PROJECT
```

The queue (and later the Scheduler job) is created and kept **paused**. No script in this repository resumes either; resuming is the owner's explicit action in section I.

C1–C9 use isolated `qp-spike-*` resources and never touch `qp-process`. Follow [infra/CLOUD_VERIFICATION.md](../infra/CLOUD_VERIFICATION.md) exactly:
build the probe image from `scripts/spike/Dockerfile`, print `node scripts/spike/setup.mjs --config D:/QueuePilot-local/spike.json`, apply stages
`identities, queues, access, deploy, iam, scheduler` one at a time, then run `node scripts/spike/probe.mjs ...` per check. Volume is bounded
(at most 20 unique tasks, at most 60 Redis PINGs). Record results in a new file shaped like `infra/cloud-results.not-run.json`, with PASS / FAIL / INCONCLUSIVE / NOT RUN.

| Check | Question | Status |
|---|---|---|
| C1 | completed task visible to `getTask`? | NOT RUN |
| C2 | name dedup after completion/deletion (docs say up to 24 h; architecture says about 1 h) | NOT RUN |
| C3 | Cloud Tasks headers | NOT RUN |
| C4 | retry deletion needs both attempts AND duration exhausted | NOT RUN |
| C5 | handler 409/429 versus platform 429 | NOT RUN |
| C6 | unauthenticated rejection; Tasks and Scheduler OIDC | NOT RUN |
| C7 | Hosting forwards `Authorization` through the rewrite | NOT RUN |
| C8 | Cloud Run to Upstash latency (PING only) | NOT RUN |
| C9 | queue-scoped `tasks.get`, `PROBE_UNKNOWN` on denied get | NOT RUN |

The design is built so wrong assumptions cost extra tasks, not wrong state (ADR-017). If C4 or C9 contradict the design, stop and propose an ADR; do not widen IAM to project level silently.

## E. Redis (Upstash or another approved provider)

1. Owner creates the database in or near `europe-west1` and records provider, region and plan.
2. TLS is mandatory: the connection string must start with `rediss://`. Put it into Secret Manager through the console or protected stdin/file,
   **never** as a command argument, in a repo file or in chat. The `bootstrap` stage only creates empty `redis-url` secret metadata; the owner adds the version.
3. Set `redisSecretVersion` in the config to that numeric version. `deploy` checks the version is `ENABLED` through metadata only and mounts it as `REDIS_URL`.
4. Behaviour to expect (verified only locally and in CI against a local Redis): burst limits degrade to per-instance limits; enforced submission quotas **fail closed**
   with `503 QUOTA_UNAVAILABLE`; `QP_QUOTA_FAILURE_MODE` is `closed` and the production guard rejects `open`.
5. Redis latency from Cloud Run is unmeasured until C8. Note the client uses 100 ms command and connect timeouts; a slow remote Redis will fail closed more often than a local one.

## F. Cloud Run (stage `deploy`, then `iam`)

1. Owner builds and pushes immutable images to Artifact Registry repository `queuepilot` in `europe-west1` (created by `bootstrap`), reviews them,
   and records `…/queuepilot/api@sha256:…` and `…/queuepilot/worker@sha256:…` in the config. Tags are not accepted; the digest must be in this project.
   The build context is always the **repository root** (the Dockerfiles live in the app folders):

```powershell
docker build -f apps/api/Dockerfile    -t europe-west1-docker.pkg.dev/ACTUAL_DEMO_PROJECT/queuepilot/api:REVIEWED .      # [docker]
docker build -f apps/worker/Dockerfile -t europe-west1-docker.pkg.dev/ACTUAL_DEMO_PROJECT/queuepilot/worker:REVIEWED .   # [docker]
gcloud auth configure-docker europe-west1-docker.pkg.dev                                                                  # [gcloud] check with --help
docker push europe-west1-docker.pkg.dev/ACTUAL_DEMO_PROJECT/queuepilot/api:REVIEWED                                       # [docker] owner action
docker push europe-west1-docker.pkg.dev/ACTUAL_DEMO_PROJECT/queuepilot/worker:REVIEWED                                    # [docker] owner action
docker inspect --format "{{index .RepoDigests 0}}" europe-west1-docker.pkg.dev/ACTUAL_DEMO_PROJECT/queuepilot/api:REVIEWED  # digest to record
```

   Image design: multi-stage; `pnpm install --frozen-lockfile`; esbuild bundle `dist/server.js` with SDK packages (including `ioredis`) external; production-only
   `node_modules` from `pnpm deploy --prod --legacy`; base `node:24.22.0-bookworm-slim` pinned by tag **and** manifest digest (override with `--build-arg NODE_IMAGE=...`; bump
   deliberately, then rerun CI); runs as the non-root `node` user; `CMD ["node","dist/server.js"]` so SIGTERM reaches the process; no `.env`, key or credential is copied
   (`.dockerignore`). CI proves only: build succeeds, `/health` answers, the user is non-root, SIGTERM exits 0, and `QP_ENV=production` with a demo project is refused.
   The images were never run against real Firestore, Redis or Cloud Tasks.
2. Deploy, worker first then API, with explicit service identities **[repo]**:

```powershell
node infra/apply.mjs --config D:/QueuePilot-local/cloud.json --stage access --apply --approve-project=ACTUAL_DEMO_PROJECT
node infra/apply.mjs --config D:/QueuePilot-local/cloud.json --stage deploy --apply --approve-project=ACTUAL_DEMO_PROJECT
node infra/apply.mjs --config D:/QueuePilot-local/cloud.json --stage iam --apply --approve-project=ACTUAL_DEMO_PROJECT
```

3. Configured limits: API 0–5 instances, concurrency 80, timeout 15 s; worker 0–3 instances, concurrency 10, timeout 60 s; 1 CPU / 512 MiB, CPU throttling, scale to zero.
   Environment is generated by `infra/spec.mjs` (`QP_ENV=production`, queue/OIDC settings, ingest limits 40 rps and 32 in flight per instance, backlog cap 20000,
   `QP_REDIS_ENABLED=true`, `QP_QUOTA_FAILURE_MODE=closed`). `QP_ENV=production` activates the startup guards against fault flags and quota fail-open.
4. Scheduler job `qp-reconcile` (stage `scheduler`) is **not created** until you pass `--approve-b4-worker-image=FULL_PINNED_WORKER_IMAGE`, which must equal the configured image
   and a ready deployed revision. It is created paused. Reconciler runs every minute once resumed.
5. Cost protection: keep everything at scale-to-zero, keep queues and the job paused when not testing, set the budget alerts first, and watch Cloud Run request counts
   and Firestore reads/writes during the first controlled run. The admission ceiling (200 accepted POST/s, about 600 writes/s) is a configured limit, not measured capacity.

## G. Firebase

1. Create/attach the Firebase project (Blaze plan is required for Cloud Run rewrites) and enable the **Google** sign-in provider.
2. Add the Hosting domain(s) to Authentication → Authorized domains.
3. Build the web app (`pnpm build`) with the demo project's public Firebase web config as Vite variables (`apps/web/src/config.ts`): `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. Leave `VITE_API_BASE_URL` empty (same origin through the Hosting rewrite) and never set `VITE_USE_MOCK_API` or the emulator URL for a cloud build. Take the values from the Firebase console; they are not secrets but are not committed here either.
4. Deploy Hosting as its own approved step **[gcloud/firebase CLI]**, using the pinned CLI from `node_modules`:

```powershell
node node_modules/firebase-tools/lib/bin/firebase.js --config infra/firebase.json --project ACTUAL_DEMO_PROJECT deploy --only hosting
```

   `infra/firebase.json` rewrites `/api/**` to Cloud Run `qp-api` (europe-west1) before the SPA fallback. C7 must confirm the rewrite forwards `Authorization`.
5. **Tenant and memberships.** Open sign-up (`POST /api/v1/session/bootstrap`) creates `member` memberships in the `sandbox` tenant only, and only if
   `tenants/sandbox` exists with `openSignup=true`. The infra scripts do not create tenants or memberships, so seed the tenant first **[repo]**. Both scripts are dry-run by
   default (no credentials, no network) and write only with `--apply` plus `--approve-project` repeating the exact project ID; they use your own `gcloud auth login` token, never a key file:

```powershell
# 1. Create tenants/sandbox (create-only; reruns report "unchanged"; drift is reported, never overwritten). The sign-up choice is mandatory.
node scripts/seed-demo.mjs --project ACTUAL_DEMO_PROJECT --open-signup true
node scripts/seed-demo.mjs --project ACTUAL_DEMO_PROJECT --open-signup true --apply --approve-project ACTUAL_DEMO_PROJECT
# 2. Sign in once with Google in the deployed UI (this creates your member membership through bootstrap). Read your UID in
#    Firebase console -> Authentication -> Users -> "User UID" (or the `uid` field of GET /api/v1/me).
# 3. Promote that one user to admin of that one tenant (a separate, explicit operation; the only supported way to create an admin).
node scripts/grant-role.mjs --project ACTUAL_DEMO_PROJECT --tenant sandbox --uid DEMO_USER_UID
node scripts/grant-role.mjs --project ACTUAL_DEMO_PROJECT --tenant sandbox --uid DEMO_USER_UID --apply --approve-project ACTUAL_DEMO_PROJECT
```

   `seed-demo.mjs --member-uid UID` can pre-create a *member* membership instead of waiting for the first sign-in; it never creates an admin. `grant-role.mjs` requires the
   tenant to exist and be active, refuses to move a user between tenants or to reactivate a suspended membership, accepts one explicit tenant and one uid (no wildcards),
   and the API caches memberships for up to 30 s, so the role takes effect within that time. Both verify the project exists, is ACTIVE and carries the
   `queuepilot-environment=demo` label before writing. Exit codes: 0 ok, 2 usage, 3 refused, 4 state conflict, 5 I/O. With `open-signup true`, anyone with a Google login can join
   `sandbox`; choose `false` to keep sign-up closed until you are ready. Sign-up quotas for `sandbox` are `10/min/user, 30/day/user, 2000/day` (ARCHITECTURE §15) and fail
   closed when Redis is unavailable. **Never run these against a real project until you have reviewed the dry-run output.**

## H. Rollback and shutdown

Order matters: stop new work, then inspect, then remove. Pause does **not** cancel in-flight requests.

1. Pause the Scheduler job and then the queue **[repo]**. `scripts/shutdown.mjs` is dry-run by default; with `--apply` it checks the project (ACTIVE, demo label, project number),
   pauses `qp-reconcile` then `qp-process` through the existing `ensurePaused` code and requires a read-back of `PAUSED`. It never deletes or resumes anything:

```powershell
node scripts/shutdown.mjs --config D:/QueuePilot-local/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1
node scripts/shutdown.mjs --config D:/QueuePilot-local/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1 `
  --apply --approve-project ACTUAL_DEMO_PROJECT --approve-region europe-west1
```

   Equivalent manual **[gcloud]** commands: `gcloud scheduler jobs pause qp-reconcile --project=ACTUAL_DEMO_PROJECT --location=europe-west1` and
   `gcloud tasks queues pause qp-process --project=ACTUAL_DEMO_PROJECT --location=europe-west1`.
   Scale-to-zero is already configured (min instances 0), so idle Cloud Run services are not billed for CPU, but this is **not** zero cost: Firestore storage and operations, Artifact
   Registry images, Secret Manager, Hosting, logs and the Upstash plan remain. The wrapper does not scale, delete or disable Cloud Run services, the Hosting site, the database or the secret;
   do those, if wanted, as separate explicit owner steps. A pause does not cancel in-flight deliveries.
2. Disable test traffic: remove or stop the load source; pause or disable the tenant (`tenants/{id}.status`) rather than deleting data.
3. Roll back Cloud Run: route traffic to the previous revision **[gcloud]** (`gcloud run services update-traffic SERVICE --to-revisions=PREVIOUS=100 --region=europe-west1`), or redeploy the previous pinned digest through stage `deploy`. Images are immutable digests, so rollback is exact.
4. Preserve data: Firestore has delete protection; never delete the database, purge `qp-process` or delete the Redis secret as part of rollback. Requests already `ACCEPTED` stay durable and the reconciler re-dispatches them when re-enabled.
5. Probe cleanup follows `infra/CLOUD_VERIFICATION.md` "Recording and shutdown".

## I. Live acceptance (only after A–G and C1–C9 are recorded)

Resume `qp-process` and `qp-reconcile` explicitly (**[gcloud]** `gcloud tasks queues resume` / `gcloud scheduler jobs resume`, with project and location flags), then verify in order,
recording evidence and treating anything not run as NOT RUN:

1. Google sign-in on the deployed Hosting URL, `GET /api/v1/me`, bootstrap into `sandbox`.
2. Submit one request: `202`, status `ACCEPTED` → `PROCESSING` → `COMPLETED`, event timeline complete (same flow as `docs/verification/e2e-local.mjs`, now against cloud).
3. Idempotent replay (`Idempotent-Replayed: true`) and `409` on a changed body.
4. Redis quota: enforced tenant over budget gives `429 QUOTA_EXCEEDED`; with the Redis secret temporarily unusable (a disposable environment only) gives `503 QUOTA_UNAVAILABLE`.
5. Metrics endpoint and Cloud Run logs contain no authorization headers, cookies or request descriptions.
6. A small controlled spike through the public API with a synthetic tenant: confirm `503 OVERLOADED` shedding and that every accepted request completes. Record numbers as **cloud measurements** separately from the local B6 ones; do not mix them.
7. Recovery: pause the queue for a few minutes, submit, resume, confirm the backlog drains; check the stuck/attention counters.
8. Shut down per section H when finished.

## Cost and risk summary

- Cost drivers: Cloud Run requests and CPU time, Firestore reads/writes/storage, Cloud Tasks operations, Secret Manager access, Artifact Registry storage, Upstash plan, Scheduler jobs beyond the free tier. All are small at demo volume, but none is measured.
- Irreversible: Firestore location. Hard to reverse: deleted queue names may not be reusable immediately; reuse paused queues.
- Security posture: API is public by design with app-level auth; worker is IAM-only; no keys; no secrets in repo. No external security review has been done.
