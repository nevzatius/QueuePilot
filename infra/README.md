# QueuePilot B2 infrastructure

Prepared offline on 2026-10-19 from `main` commit `39cc436`. No cloud credentials were read and no cloud resources were inspected or changed. C1–C9 are **NOT RUN**. The cloud runbook is [CLOUD_VERIFICATION.md](CLOUD_VERIFICATION.md); the proposed PR description is [HANDOFF.md](HANDOFF.md).

## Offline use

Run from the repository root with Node 24:

```powershell
node infra/apply.mjs
node scripts/spike/setup.mjs
node scripts/spike/probe.mjs
node --test infra/offline.test.mjs infra/targeted.test.mjs
```

The first three commands print JSON plans, including desired resource bodies, without invoking gcloud, reading ADC, or using the network. Plans contain references, never secret payloads. Configuration is checked for unknown keys. No credentials belong in a configuration file.

## Owner prerequisites and approval boundary

Only the owner runs cloud commands after reviewing the plan and approving the named demo project, cost, region, IAM and deployments. The scripts do not enable billing, select an active gcloud project, initialize Firebase, create service-account keys, or run a build. They never apply the `all` stage.

1. Supply an existing dedicated demo GCP project with billing approved, Service Usage and Resource Manager APIs available, a numeric project number, and label `queuepilot-environment=demo`. Production projects are forbidden. The label and exact project number are checked before any write. A project name alone cannot prove isolation; the owner must confirm that it contains no production resources.
2. Confirm the irreversible regional Firestore choice `europe-west1` (ADR-007), default Native database and Firebase project attachment/Blaze plan. Every `data --apply` requires both `--approve-project=ACTUAL_DEMO_PROJECT` and `--approve-firestore-location=europe-west1`. Missing/inconsistent approval stops before credentials or cloud calls; database creation rechecks both at the write boundary. These explicit arguments support noninteractive CI without assuming consent from the region default. Existing region/type/delete-protection mismatch stops the script. No database migration or deletion is attempted.
3. Install gcloud locally as the owner, then authenticate using the owner's normal short-lived login. The script obtains a short-lived access token through gcloud only in explicit apply/run mode; it does not persist or print tokens. Node 24 and the repository's pinned pnpm are required. There is no global tool installation in these scripts.
4. Review organization policies for public API access and permitted service-account impersonation. Audit inherited project/folder/org IAM: service-level checks cannot undo inherited worker invocation rights. Worker IAM checks must stay enabled.
5. Configure Firebase Google sign-in, authorized domains and a Hosting site manually. B2 does not provision user accounts, tenants, memberships, an Upstash subscription or a billing account.
6. Establish a billing budget/alerts and a cost review time before starting. Instance/queue limits bound throughput; they are not a hard monetary cap. Keep all queues and jobs paused until application authentication, quota enforcement, startup fault-flag refusal and log redaction are reviewed in B3/B4.

Copy `infra/config.example.json` outside the repository to a local non-secret configuration, replace project ID/number and image references, and pin the numeric `redisSecretVersion`. The examples below use `D:/QueuePilot-local/cloud.json`. For plans it is safe to retain placeholder images; deployment requires existing same-project `europe-west1` Artifact Registry images pinned by SHA-256 digest.

## Guarded wrappers and owner scripts (B7)

All of these are dry-run by default (no credentials, no network), refuse anything ambiguous, and were tested offline (`scripts/scripts.test.mjs`) and, for the Firestore scripts, against the
Firestore emulator (`tests/integration/owner-scripts.test.ts`). None has been run against a real project.

| Script | Purpose | Guards |
|---|---|---|
| `scripts/preflight.mjs` | Local readiness report: PASS / FAIL / BLOCKED / NOT RUN. Never calls GCP, prints env names only | read-only |
| `scripts/deploy.mjs` | One stage of this staged model, with a readable plan and digest, then delegates to `apply.mjs` | `--project`, `--region europe-west1`, `--approve-project`, `--approve-region`, `--approve-plan`; stage extras: `--approve-firestore-location`, `--approve-public-api` (iam), `--approve-b4-worker-image` (scheduler). Never resumes queues/jobs |
| `scripts/shutdown.mjs` | Pauses `qp-reconcile` then `qp-process`, requires read-back `PAUSED` | project identity + demo label, `--approve-project`, `--approve-region`; deletes nothing |
| `scripts/seed-demo.mjs` | Creates `tenants/sandbox` (create-only, idempotent); optional member membership | `--open-signup true|false` mandatory, `--apply`, `--approve-project`; never creates an admin |
| `scripts/grant-role.mjs` | The only supported admin grant (ARCHITECTURE §11) for one uid in one existing active tenant | `--apply`, `--approve-project`; refuses tenant moves and suspended memberships |

Credentials for the two Firestore scripts and the shutdown wrapper are the owner's `gcloud auth login` token (same mechanism as `cloud.mjs`); no key files. They address the project explicitly
instead of relying on gcloud's active project, and check that the project is ACTIVE and labelled `queuepilot-environment=demo` (the Firestore scripts also compare the number when `--project-number` is given; shutdown and apply always do). With `FIRESTORE_EMULATOR_HOST` set they accept only loopback hosts and `demo-*` projects.
Unresolved assumption: the REST calls for these scripts follow the Firestore v1 `documents:commit` API as exercised on the emulator; they have not been exercised on production Firestore.

## Ordered owner execution

Print the full plan with `--config` before running any apply command. Every apply requires **one** explicit stage and `--approve-project=ACTUAL_DEMO_PROJECT`. For example, after owner approval:

```powershell
node infra/apply.mjs --config D:/QueuePilot-local/cloud.json --stage bootstrap --apply --approve-project=ACTUAL_DEMO_PROJECT
```

Run stages in this order, separately reviewing each result:

| Stage | Managed changes / gate |
|---|---|
| `bootstrap` | Enable Resource Manager, Run, Tasks, Scheduler, Firestore, Firebase Rules, Secret Manager, IAM, IAM Credentials and Artifact Registry APIs; ensure Tasks/Scheduler service identities, four runtime accounts, custom queue roles, `queuepilot` Docker repository and empty `redis-url` secret metadata. Resource Manager must already be available for the initial project identity check. No secret version is created. |
| Owner secret/image gate | Put a TLS Upstash `rediss://` connection string into Secret Manager using the console or protected stdin/file; never a command argument or checked-in file. Build (`apps/api/Dockerfile`, `apps/worker/Dockerfile`, repository root as context), review and push the API/worker images as owner and record immutable digests. The images are built and smoke-run in CI only; they have never run against real Google Cloud services. |
| `data` | Require explicit project and Firestore location approval; create regional default database with delete protection if absent; install deny-all rules, ensure three composites, exemptions and three TTL policies. Index/field writes report PENDING; rerun until reads confirm READY/ACTIVE before traffic. A successful command or completed operation alone does not prove readiness. |
| `queue` | Ensure `qp-process` with architecture retry/rate/concurrency settings. New and existing active queues are paused and re-read; successful output includes actual state=PAUSED. There is a brief create-to-pause interval, so do not enqueue concurrently. Reapplying provisioning pauses an active demo. |
| `access` | Project datastore grants, queue-scoped custom roles, actAs only on the Tasks invoker, secret-level accessor, and platform service-agent roles. Must precede deployment so secret mounts work. |
| `deploy` | Verify pinned secret version is enabled; deploy private worker first, then API, with explicit service identities, 8080 port, 1 CPU/512 MiB, CPU throttling, scale-to-zero, service/revision maxima, concurrency and timeouts. IAM checks enabled. No public grant is added by this stage. |
| `iam` | Grant only Tasks/Scheduler identities worker invocation, and `allUsers` API invocation. Abort if the worker has direct public IAM bindings. Public API application auth is a prerequisite. |
| `scheduler` | Without deployment approval, an absent job reports DEFERRED (state=ABSENT) and is not created. Only after B4 is deployed and reviewed, pass `--approve-b4-worker-image=FULL_PINNED_WORKER_IMAGE`. It must match config and a fully ready deployed worker revision before creation. Existing active jobs are paused before comparison/update; new jobs are paused and re-read. No same-minute retries; next cron tick supplies recovery. |
| Owner Hosting gate | Review/build `apps/web/dist`, then owner runs the pinned Firebase CLI with `--config infra/firebase.json --project ACTUAL_DEMO_PROJECT deploy --only hosting`. This is a separate explicitly approved deployment. `/api/**` rewrite precedes the SPA fallback. |
| Owner activation gate | Inspect queue/job/IAM/service URLs and complete applicable cloud checks. Only then explicitly resume `qp-process` and `qp-reconcile`, using project and location flags. |

The deterministic worker origin is `https://qp-worker-PROJECT_NUMBER.europe-west1.run.app`. Verify it appears in the deployed service's URLs before activation. Both Tasks and Scheduler use this exact origin as their OIDC audience, without the handler path. The Tasks OIDC identity and `dispatchDeadline=30s` are **per-task** settings, represented in the API/worker environment and spike createTask payload; existing queue routing/authentication overrides cause an error requiring owner review. B4 must attach OIDC/deadline to every createTask request.

The B4 image approval attests that the named image implements the reviewed reconciler; Cloud Run readiness alone cannot establish application correctness. Scheduler state is output-only, so creation and pause are not atomic. Before B4 approval no reconciliation job is created; after approval a brief execution window remains possible before pause. Activation is a separate owner action: these scripts never resume queues or jobs. A pause error or a read that fails to confirm PAUSED exits nonzero, including on reapplication after a partial creation.

The environment names in `spec.mjs` are the infrastructure-to-B3/B4 configuration proposal, checked by `scripts/preflight.mjs` against `packages/core/src/config.ts` (the names exist; cloud behaviour is unverified). Startup must reject `QP_FAULT_*` and quota fail-open in production. Application loggers must redact authorization, cookies and description. The demo runs with `QP_ENV=production` to exercise these guards.

## IAM requirements

| Principal | Scope | Permissions / role |
|---|---|---|
| `qp-api-sa` | `qp-process` only | custom `qpEnqueuer`: `cloudtasks.tasks.create` |
| `qp-worker-sa` | `qp-process` only | custom `qpReconciler`: `cloudtasks.tasks.create`, `cloudtasks.tasks.get` |
| API and worker | Project | `roles/datastore.user`; no Firebase Auth admin role |
| API and worker | `qp-tasks-invoker-sa` only | `roles/iam.serviceAccountUser` (`iam.serviceAccounts.actAs`) |
| API and worker | `redis-url` only | `roles/secretmanager.secretAccessor` |
| Tasks/Scheduler invoker accounts | `qp-worker` only | `roles/run.invoker` |
| `allUsers` | `qp-api` only | `roles/run.invoker` |
| Tasks platform agent | Project | `roles/cloudtasks.serviceAgent` (token minting); never grant this role to runtime accounts |
| Tasks platform agent | `qp-tasks-invoker-sa` only | `roles/iam.serviceAccountUser`, per the HTTP-target authentication setup guide |
| Scheduler platform agent | Project | `roles/cloudscheduler.serviceAgent`; retain this for authenticated HTTP jobs |

`tasks.get` BASIC does not require `tasks.fullView`, `tasks.list`, `queues.get` or `tasks.delete`. Named createTask requires `tasks.create`, plus actAs for the attached OIDC identity. Custom roles avoid the additional permissions in broad predefined queue roles. Queue-level create/get scope is documented but remains a C9 live verification gate. Failed probes only classify explicit HTTP 404 + `NOT_FOUND` as absence; permission, quota, network and other failures remain unknown.

The **owner provisioner**, separately from runtime accounts, needs permission to read the project/labels and resource state; enable services/create service identities; create/get/update custom roles and accounts; create/describe queues and pause them; get/set the relevant IAM policies; create/read/update Run services and actAs on their runtime identities; create/get/update/pause Scheduler jobs and actAs on its OIDC identity; create/read databases/indexes/fields and TTL policies; read operation status; create/read secrets metadata and version metadata; create/read the image repository; and create/read/update Firebase rulesets/releases. Hosting needs its own Firebase deployment permissions. Use approved temporary provisioning roles or a reviewed custom provisioner role, not runtime admin grants. Denied reads stop execution; they never trigger blind creation. Public grants may be blocked by org policy; the script never works around it by disabling IAM checks.

## Reapplication, drift and recovery

`cloud.mjs` uses gcloud authentication and direct Google REST APIs to compare managed state before writes. Only explicit NOT_FOUND permits creation. IAM reads use resource-specific methods and request-policy version 3; changes preserve unrelated and conditional bindings plus etags. Role/policy conflicts fail and require re-read on rerun. Existing disabled/deleted resources stop execution. Scheduler comparison normalizes omitted retry defaults and protobuf durations; backoffs are ignored only when both retry limits disable retries. Nonzero retry limits remain managed drift. Composite index field order matters, server-added `__name__` does not; no index is deleted. Map exemptions on `processing`/`dispatch` cover their descendants. TTL also exempts `expiresAt` from indexing and applies independently to requests, events and idempotency keys. No application data is written by infrastructure setup.

Successful reapplication is a no-op for matching resources already paused; platform service-identity generation is an idempotent ensure operation. This has been checked against mocked responses only. Live convergence, provider normalization, IAM propagation and exact deployed image readiness remain owner checks. Stop at errors; inspect long-running operations, then rerun the same stage. No automatic retries of ambiguous writes, permission broadening, rollbacks, replacement, purge, destructive cleanup or drift deletion occurs. If creation succeeds but pause fails, the command fails: immediately pause the queue/job manually before proceeding. Rerunning provisioning attempts pause again and requires read-back confirmation.

TTL and the single-field exemption are deliberately configured together as `{ indexConfig: { indexes: [] }, ttlConfig: {} }` with update mask `indexConfig,ttlConfig`. Cloud verification must separately establish (1) each `expiresAt` field has ACTIVE TTL and no inherited single-field indexes, and (2) timestamped, expired disposable records are actually deleted asynchronously. CREATING TTL and pending index/field operations report PENDING. No cloud activation or deletion evidence has been collected by offline tests.

Shutdown: pause Scheduler jobs and all queues first, inspect in-flight work (pause does not cancel it), disable the temporary Hosting site, and delete isolated probe services/jobs/queues/identities after retaining evidence. Deletion is an explicit owner operation. Keep Firestore and secrets protected; TTL is asynchronous and request deletion does not cascade to events. Main Firestore TTL on requests/events is for load-test records that actually carry `expiresAt`.

## Primary references reviewed

- [Queue retry/rate configuration](https://docs.cloud.google.com/tasks/docs/configuring-queues), [createTask permission and deduplication](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create), [getTask permission and deletion](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/get).
- [Project and queue IAM scopes](https://docs.cloud.google.com/tasks/docs/access-control), [HTTP task OIDC](https://docs.cloud.google.com/tasks/docs/creating-http-target-tasks), [Scheduler HTTP authentication](https://docs.cloud.google.com/scheduler/docs/http-target-auth).
- [Firestore index/TTL definitions](https://firebase.google.com/docs/reference/firestore/indexes), [TTL lifecycle](https://docs.cloud.google.com/firestore/native/docs/ttl), [Cloud Run deterministic URLs](https://docs.cloud.google.com/run/docs/custom-urls), [Hosting Run rewrite](https://firebase.google.com/docs/hosting/cloud-run).
- IAM policy REST reads: [service accounts (POST, empty body, query options)](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts/getIamPolicy), [queues (POST, body options)](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues/getIamPolicy), [projects (POST, body options)](https://docs.cloud.google.com/resource-manager/reference/rest/v1/projects/getIamPolicy), [Run services (GET)](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/getIamPolicy), [secrets (GET)](https://docs.cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/getIamPolicy).
- [Scheduler retry defaults and output-only state](https://docs.cloud.google.com/scheduler/docs/reference/rest/v1/projects.locations.jobs).

These references support configuration and test expectations; they are not evidence that C1–C9 ran in this project.
