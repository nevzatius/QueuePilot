# B7 owner runbook: controlled Google Cloud deployment

> **No billing account?** Use the [free-tier path](#free-tier-path-adr-019-firebase-spark--render-free--upstash) first; sections 0 to I are the paid Google Cloud path.

Status: **prepared offline (2026-10-20, extended by the B7 pre-deployment hardening). Nothing here has been run against Google Cloud.**
No Google Cloud project, billing, resource or credential was touched, and C1–C9 are all **NOT RUN**. Every command below is executed by the **owner**, after reviewing the plan it prints.
Agents do not deploy. Source of truth for behaviour: [infra/README.md](../infra/README.md),
[infra/CLOUD_VERIFICATION.md](../infra/CLOUD_VERIFICATION.md), [ARCHITECTURE §14](ARCHITECTURE.md), ADR-007/011/016.

Command provenance: commands marked **[repo]** are implemented by scripts in this repository and covered by offline tests.
Commands marked **[docker]** and **[gcloud]** are standard Docker, gcloud or Firebase CLI operations that the repository documents in prose but does not script;
check them with `--help` before running. Placeholders in `CAPITALS` are yours to fill in; none is invented here.

## Free-tier path (ADR-019): Firebase Spark + Render free + Upstash

> **STOP if any page asks for a card, a payment method or a billing account.** Close it, change nothing, and tell the maintainer which page asked.
> Every service below has a free plan that needs none. Never click "Upgrade", "Blaze", "Add payment method" or a paid instance type.

Status: **prepared offline (B9-7); first live run 2026-10-22/23 (B9-9)**, recorded in `docs/TASKS.md` ("B9-9 live results"). Steps marked **(observed)** below come from that run; anything the run did not check is still NOT VERIFIED. The GCP sections below (0 to I) are the
paid path and are not needed here. Secrets go into the Render dashboard or into your shell session only: never into chat, a commit, a command argument or a file in the repo.
Placeholders in `CAPITALS` are yours to fill in; none is invented here. Commands are PowerShell; **[repo]** marks scripts in this repository.

Fixed names used below: Redis database `queuepilot`; Render services `queuepilot-api` and `queuepilot-worker` (from `render.yaml`, Frankfurt); Firestore `europe-west1`.

**0. Prerequisites (once, on the machine you will type the commands on).**
1. **Node 24.x** (`node --version` prints `v24...`; `package.json` requires `>=24 <25`). Corepack ships with Node, and every command below is written `corepack pnpm ...`, so no global pnpm install is needed (`corepack enable` is optional).
2. **Clone the repository** (private; sign in to GitHub when asked): `git clone <your QueuePilot repository URL>`, then `cd QueuePilot`. Run every command below from that folder.
3. **Install the dependencies:** `corepack pnpm install`. This also installs the pinned Firebase CLI, used below as `corepack pnpm exec firebase`.
4. **Google Cloud CLI (`gcloud`)**: install it from Google's installer page (cloud.google.com/sdk/docs/install), open a new terminal, then `gcloud auth login` and sign in with the Google account that owns the Firebase project. It is used for the project label (step 1.5) and by `seed-demo` / `grant-role` (step 9). It does not enable billing and needs no card.
5. **Firebase login:** `corepack pnpm exec firebase login` (opens a browser; same Google account).
6. Docker is **not** needed: Render builds the images itself. Do not run `pnpm build` for this path either, except for the web build in step 7.

**0b. Check the files [repo].** `node scripts/preflight.mjs --profile free`. It checks `render.yaml`, `firebase.json`, the Firestore indexes and rules against each other and the production guards; it does not check that any service exists or that any account is set up. It reads files and variable *names* only, and exits 0 unless a check says `FAIL`.
- **On a machine that has only done 0.1 to 0.3, no `FAIL` is expected.** Observed 2026-10-22 on a copy of this branch with no `node_modules`, no build output, Node 24.18 and neither `gcloud` nor Docker installed: no `FAIL`, and `BLOCKED` for exactly these items: `artifact-api` and `artifact-worker` (no `pnpm build`; not needed here), `tool-docker` (not needed), `tool-gcloud` (goes `PASS` after 0.4), `config-file` (GCP path only), `env-REDIS_URL` (local real-Redis runs only) and `free-firebaserc` (the project id is still the placeholder). Every other `free-*` line was `PASS`. The `NOT RUN` lines are external checks that no local command can make; they are always there.
- `free-firebaserc` stays `BLOCKED` for the whole path, by design: **do not edit `.firebaserc`**. Every `firebase` command below passes `--project PROJECT_ID`, which overrides the placeholder.
- A `FAIL` means a repository file was changed or damaged (for example a paid plan in `render.yaml`, or a TTL override in the Firestore indexes file): stop, do not deploy, and tell the maintainer the line. `tool-node` is `BLOCKED` when Node is not 24.x.

**1. Firebase project (Spark).**
1. Console > Add project. Skip Analytics. Keep the plan on **Spark**. Note `PROJECT_ID` (Project settings > General) and the **project number**.
2. Build > Firestore Database > Create database > **location `europe-west1`** (cannot be changed afterwards) > production mode.
3. Build > Authentication > Sign-in method > enable **Google**. (`PROJECT_ID.web.app` and `PROJECT_ID.firebaseapp.com` are authorised domains by default.)
4. Project settings > Your apps > register a **Web app**; copy `apiKey`, `authDomain`, `projectId`, `appId` (public config, used in step 7).
5. Label the project `queuepilot-environment=demo`, because `seed-demo` and `grant-role` refuse unlabelled projects (needs `gcloud auth login`).
   **(observed)** `gcloud projects update --update-labels` is **not recognized** by Google Cloud SDK 590.0.0 (nor under `gcloud beta`). Use the Cloud Resource Manager v3 API instead. `PROJECT_NUMBER` is the project **number**, not the id (step 1.1).
   `updateMask=labels` **replaces the whole label set**, so send every existing label plus the new one (a Firebase project already carries `firebase=enabled` and `firebase-core=disabled`; keep them). The token stays in a variable and is never printed. The live run did this PATCH; the snippet below is a PowerShell transcription of it and was not re-run as written:

   ```powershell
   $token = gcloud auth print-access-token
   $headers = @{ Authorization = "Bearer $token" }
   $uri = "https://cloudresourcemanager.googleapis.com/v3/projects/PROJECT_NUMBER"
   $project = Invoke-RestMethod -Uri $uri -Headers $headers          # read the current labels first
   $labels = @{}
   if ($project.labels) { $project.labels.PSObject.Properties | ForEach-Object { $labels[$_.Name] = $_.Value } }
   $labels['queuepilot-environment'] = 'demo'
   Invoke-RestMethod -Method Patch -Uri "${uri}?updateMask=labels" -Headers $headers -ContentType 'application/json' -Body (@{ labels = $labels } | ConvertTo-Json)
   ```

   Check by reading the project again: all the labels, including the new one, must be there.

**2. Service-account key (the API and worker have no Google identity on Render).**
1. Project settings > Service accounts > **Generate new private key**. Save the JSON **outside the repo** (for example `<secrets-dir>`).
2. You will paste its whole content into the Render field `QP_FIREBASE_SERVICE_ACCOUNT_JSON` in step 4. The apps accept it only from that variable, check it at startup and print a constant message if it is wrong (never its content).
3. This is a long-lived credential for the Firebase Admin service account (broad project access). Delete the key in the console at shutdown (step 11).

**3. Upstash.**
1. Redis > Create database named **`queuepilot`**, a Europe region, **TLS on**, free plan. Copy the `rediss://...` URL (`REDIS_URL`).
2. QStash > copy the **token**, the **current** and **next signing keys**, and the **URL** shown beside the token (`QSTASH_URL`; tokens are regional).
3. **(observed) Paste every Upstash value WITHOUT quotes.** The Upstash console copies `REDIS_URL`, `QSTASH_URL`, the token and both signing keys with surrounding double quotes. In the live run the first Render start failed with `Invalid API configuration` because of them, and after the first fix one worker variable was still wrong (quotes or a stale value; the cause was not recorded). Remove the quotes from each value before pasting it into Render (both services). Before deploying, put the values in a local env file **outside the repo** and run `node scripts/config-doctor.mjs` on it: it found the quoted values in the live run.

**3a. Check your values before deploying [repo].** Run the configuration doctor before you create the services (and again before every change of a value). It builds the environment each Render service would get (the fixed values of `render.yaml` plus your values) and runs the **same loader the service runs at startup**, locally: no network, nothing is sent anywhere, and it never prints a value (only names, presence, length and whether a value has leading/trailing whitespace).
1. Put your dashboard values in a text file **outside the repository** (the doctor refuses a file inside it), one `NAME=VALUE` per line, for example `<secrets-dir>/secrets.txt`: `GCLOUD_PROJECT`, `QP_WORKER_URL`, `QP_CORS_ORIGINS`, `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `REDIS_URL`. Exact rules: blank lines and lines starting with `#` are ignored; everything after the first `=` is the value, character for character (no trimming, **no quote stripping**: write `REDIS_URL=rediss://...`, not `REDIS_URL="rediss://..."`); a name twice is an error. Keep the service-account key as its own file, for example `<secrets-dir>/key.json` (the doctor minifies it the way the clipboard command in step 4.2 does).
2. Run it once per service:

```powershell
node scripts/config-doctor.mjs --service api --env-file <secrets-dir>/secrets.txt --service-account-file <secrets-dir>/key.json
node scripts/config-doctor.mjs --service worker --env-file <secrets-dir>/secrets.txt --service-account-file <secrets-dir>/key.json
```

3. Read the verdict. `PASS` means the loader accepts the configuration (not that the values are right for the real services). `FAIL` lists the variable **names** with a reason code: `missing`, `blank`, `whitespace` (a stray space or newline around the value), `wrong_format`, `not_https`, `not_origin` (a path, query or trailing slash), `not_rediss` (use the `rediss://` TLS URL), `invalid_json` / `project_mismatch` (service-account key), `out_of_range`, `mismatch`, `not_allowed`, plus `wildcard`, `empty_entry`, `too_many`, `duplicate`, `loopback_in_production` for `QP_CORS_ORIGINS`. Fix the value in your file and run again. Exit codes: 0 PASS, 1 FAIL, 2 usage or a malformed env file, 3 refused (a file inside the repository), 5 a file cannot be read.
4. Two things the loader accepts on purpose, so the doctor passes them: a **blank** `QSTASH_URL` (read as the global default; the doctor lists it under `Blank:`) and entries in `QP_CORS_ORIGINS` separated by `, ` (each entry is trimmed). A trailing space on a URL is trimmed as well; the `leading/trailing whitespace` column still shows it.
5. A service that fails at startup now prints the same names in its log: `Invalid API configuration [QP_WORKER_URL wrong_format]` or a named message followed by `[NAME reason]`. Use that line with this step to find the value.

**4. Render services from the Blueprint.**
1. Render dashboard > New > **Blueprint** > connect the GitHub repository, branch `main`. The two services must show **Free**; if the page asks for a payment method, STOP.
2. Render asks for every `sync: false` value. Enter them for **both** services (the same value each time): `GCLOUD_PROJECT` = `PROJECT_ID`; `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `REDIS_URL`; `QP_FIREBASE_SERVICE_ACCOUNT_JSON` (paste the key file content).
   **No Render prompt may be left empty.** An empty `QP_FIREBASE_SERVICE_ACCOUNT_JSON` makes both services refuse to start (`QP_FIREBASE_SERVICE_ACCOUNT_JSON is required on this host`: Render has no Google identity). An empty `QP_CORS_ORIGINS` starts the API but leaves it unusable from the browser (the API logs a `CONFIG_WARNING` at boot). An empty `QSTASH_URL` is read as the global default, but enter the URL beside your token anyway (tokens are regional). Empty `QSTASH_*`, `REDIS_URL`, `GCLOUD_PROJECT` or `QP_WORKER_URL` stop the boot with a constant message.
   Paste the key file as it is. If a service then reports `QP_FIREBASE_SERVICE_ACCOUNT_JSON is invalid`, Render stored the multi-line paste differently from what the file holds: paste a one-line version instead (`Get-Content KEY.json -Raw | ConvertFrom-Json | ConvertTo-Json -Compress | Set-Clipboard`; not run yet, B9-9 records how Render stores it).
3. Also for both: `QP_WORKER_URL` = `https://<your-worker>.onrender.com` (the **expected** worker origin: no path, no trailing slash; corrected in step 5).
   For the API only: `QP_CORS_ORIGINS` = `https://PROJECT_ID.web.app,https://PROJECT_ID.firebaseapp.com` (the Hosting origins; a request from any other origin gets no CORS headers).
4. Create. `render.yaml` already fixes `QP_ENV=production`, `QP_QUEUE_ADAPTER=qstash`, `QP_WORKER_AUTH_MODE=qstash`, `TRUST_PROXY_HOPS=3` (API), the free plan and `autoDeployTrigger: off`.
   Nothing redeploys by itself after a code change; use **Manual Deploy**.

**5. Set the two URLs (the circularity).** The API publishes to the worker, and the worker accepts a QStash call only if the JWT `sub` equals `QP_WORKER_URL` + path, so both services need the worker's real public origin, which Render shows only after the first deploy.
1. Open each service and copy its URL (`https://....onrender.com`). Check: the worker URL equals what you typed in step 4.3. If not, set `QP_WORKER_URL` on **both** services to the real one and save (Render redeploys).
2. Note the API URL (`API_URL`) for step 7. Check: `GET API_URL/health` and `GET WORKER_URL/health` each answer `{"status":"ok"}`. The first call after idle takes about 8 to 50 s (cold start); that is expected.
   **Measured cold start (one run each, approximate):** the earlier spike measured a bare sleeping-service response at 8 to 14 s. In the live run, with the API asleep, the dashboard was usable about **30 s** after opening the page (page load + sign-in + bootstrap; a hand stopwatch, approximate) and the web showed the cold-start notice. A request submitted afterwards with the worker asleep: accepted by the API at T+0, "Processing started" at T+25 s (worker wake through QStash), "Completed" at T+26 s, so processing itself took about 1 s (attempts 1/5, duplicate deliveries 0; worker figures are server-side timestamps of that request's timeline). This is one run each, not a distribution: do not quote it as a latency guarantee.
3. **Readiness check (do this once after the first deploy, on both services):** `GET API_URL/ready` and `GET WORKER_URL/ready` must each answer **200** (`{"status":"ok"}` on the API, `{"status":"ready"}` on the worker). Unlike `/health`, each call makes one real Firestore read (the document `tenants/sandbox`; it need not exist yet) with the service-account credential, so it is the check that proves the key, the project id and the Firestore database together. A **503** (or a call that hangs past the cold start) means Firestore could not be read: the service-account key is missing, wrong, from another project or revoked (step 2, step 4.2), or the database was not created (step 1.2). Fix the value in Render and redeploy; the logs name only a constant code, never the key. Do not use `/ready` as Render's health check path: Render polls it all day and every poll would spend a read of the 50K/day Spark quota (`/health` reads nothing and stays the health check).
4. If a service shows "Deploy failed", read its logs: a message such as `Invalid API configuration [QP_WORKER_URL wrong_format]`, `QP_FIREBASE_SERVICE_ACCOUNT_JSON is required on this host [...]` or `QP_FIREBASE_SERVICE_ACCOUNT_JSON is invalid [...]` names the setting and a reason code, never the value. Reproduce it locally with step 3a.

**6. Hosting origin.** `QP_CORS_ORIGINS` (step 4.3) must contain the exact origin the browser loads the web app from. If you use another Hosting site or a custom domain, add its origin there (comma separated, https only, no wildcard) and save.

**7. Deploy Hosting, Firestore rules and indexes.** Build the web app against the API, then deploy with the pinned CLI (Spark has Hosting, Firestore rules and indexes, no Functions, no Storage). Rules stay deny-all (the Admin SDK ignores them):

```powershell
$env:VITE_API_BASE_URL = 'API_URL'            # https origin, no trailing slash
$env:VITE_FIREBASE_API_KEY = '...'; $env:VITE_FIREBASE_AUTH_DOMAIN = 'PROJECT_ID.firebaseapp.com'
$env:VITE_FIREBASE_PROJECT_ID = 'PROJECT_ID'; $env:VITE_FIREBASE_APP_ID = '...'
corepack pnpm --filter @queuepilot/web build
corepack pnpm exec firebase --project PROJECT_ID deploy --only hosting,firestore
```

Never set `VITE_USE_MOCK_API` or the emulator URL. Check: `https://PROJECT_ID.web.app` loads the sign-in page.

The free `firebase.json` deploys `infra/firestore.indexes.free.json`: the same three composite indexes and field exemptions as the GCP path (`infra/firestore.indexes.json`), **without** the three `ttl` overrides, because Firestore TTL deletes need billing (the preflight fails if the referenced indexes file contains `"ttl": true`).
Expiry stays **logical** (ADR-005): the code ignores an expired idempotency record and takes it over, so nothing depends on TTL deleting anything. The cost is that expired demo documents (`requests`, `events`, `idempotencyKeys`) are **not deleted automatically**. For a small demo that is acceptable on the 1 GiB Spark storage quota; clear data in the Firestore console, or delete the project at shutdown. The hosted shell is served with `Cache-Control: no-cache` and only `/assets/**` (hashed files) as immutable, so a redeploy is never hidden behind a stale `index.html`.

**8. QStash schedule [repo].** Every 60 minutes, `POST WORKER_URL/internal/reconcile`. The token comes from your shell only (hidden prompt; there is no `--token` option):

```powershell
$secure = Read-Host 'QStash token' -AsSecureString; $env:QSTASH_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
$env:QSTASH_URL = 'QSTASH_URL'; $env:QP_WORKER_URL = 'WORKER_URL'
node scripts/qstash-setup.mjs                                    # dry run: one read-only listing, prints the destination and what it would do
node scripts/qstash-setup.mjs --apply --approve-destination WORKER_URL/internal/reconcile
node scripts/qstash-setup.mjs --apply --approve-destination WORKER_URL/internal/reconcile   # again: "updated" under the same id, still one schedule
```

`QSTASH_URL` has the shape `https://qstash-<region>.upstash.io` (the URL beside your token). Check: the Upstash console lists exactly one schedule with cron `0 * * * *`. Exit codes: 0 ok, 2 usage, 3 refused, 4 state conflict, 5 I/O (401 wrong token or region, 429, 5xx). `--approve-destination` alone never writes; a write needs `--apply` as well.
The QStash schedule listing does not show a schedule's timeout, so the script cannot tell whether it is current: every apply rewrites the existing schedule in place (`Upstash-Schedule-Id`, same id, no duplicate, no message published), which is also how a changed `--timeout` is applied. The re-read confirms cron, method, retries and that the schedule is not paused; check the timeout in the Upstash console if it matters. The API shapes come from the QStash API reference (list, create) and are **unverified live** (B9-9).
The timeout format is `<number><s|m|h>` (`90s`, `5m`); `1m30s`, `1.5s` and `90000ms` are refused, and so is anything outside 60 s to 15 min.

**9. Tenant and admin [repo]** (uses your `gcloud auth login`; `PROJECT_NUMBER` from step 1). The free profile seeds `sandbox` with sign-up **closed** and **300 requests per day**:

```powershell
node scripts/seed-demo.mjs --project PROJECT_ID --profile free                                   # dry run
node scripts/seed-demo.mjs --project PROJECT_ID --profile free --apply --approve-project PROJECT_ID --project-number PROJECT_NUMBER
```

**(observed) Order that worked with the free-profile default (sign-up closed):**
1. Sign in with Google once on the Hosting site. The first sign-in shows "Join the sandbox workspace"; pressing Join answers **"Sign-up is closed for this workspace"**. That is the designed behaviour, not a fault. The sign-in is still required: `grant-role` checks the Auth account, so the user must sign in once **before** `grant-role`.
2. `seed-demo --profile free`: dry run, then the `--apply` command above (with `--project-number`). It created the tenant `sandbox`.
3. `grant-role` as in section G, steps 3 and 4: the dry run prints the uid, then `--apply --approve-uid UID` gave the admin role.

Alternative (not run in the live run): seed with `--open-signup true` (add it to both commands) so Join works for your own first sign-in. To close sign-up again, change `openSignup` in the Firestore console: a re-run of the seed reports an existing tenant as DRIFT and never overwrites it.
`--tenant-daily-limit N` (1 to 2000) changes the cap. Spark allows 20K writes/day and a request costs 7, so 300/day leaves ample headroom.

**10. Verify (what "works" means here).** This is the acceptance list; what the first live run did and did not check is in `docs/TASKS.md` ("B9-9 live results"):
- [ ] Sign in with Google on the Hosting site; the dashboard loads (a "service waking up" notice during a cold start is normal).
- [ ] Submit one request: it reaches **COMPLETED** (cold start plus the QStash hop can take a minute or two). The QStash log shows one delivery answered 200.
- [ ] The browser console shows no CORS error; a request from another origin has no `Access-Control-Allow-Origin`.
- [ ] After the schedule's first tick, the QStash log shows `POST .../internal/reconcile` answered 200 (not 401).
- [ ] Counters stay inside the free limits: QStash 1,000 messages/day, Firestore 50K reads and 20K writes/day, Redis 500K commands/month.

**11. Shut everything down (reverse order).** The data is synthetic; nothing here deletes anything you cannot recreate.
1. QStash schedule first, so nothing keeps calling a service you are about to delete. In a new shell repeat the environment of step 8 (`QSTASH_TOKEN` from the hidden prompt, `QSTASH_URL`, and `QP_WORKER_URL` = the worker origin **the schedule was created with**), then `node scripts/qstash-shutdown.mjs` (dry run lists the schedule), then the same with `--apply --approve-destination WORKER_URL/internal/reconcile`.
   **The script deletes only a schedule whose destination equals `QP_WORKER_URL/internal/reconcile` exactly.** If the worker URL changed after a setup run (a renamed or recreated service, a custom domain), the old schedule is orphaned: the dry run says "No matching schedule" while one still exists and keeps ticking against a dead URL. So **open the Upstash console, QStash > Schedules, and check by eye that the list is empty**; delete any leftover there by hand.
2. Render: **delete both services and the Blueprint**, then revoke Render's access to the GitHub repository (GitHub > Settings > Applications > Render, or the repository's installed GitHub Apps). Suspending is not enough if you want nothing left.
3. Upstash: delete the `queuepilot` Redis database; rotate or delete the QStash token and signing keys if you will not reuse them.
4. Firebase: delete the **service-account key** (Project settings > Service accounts > Manage), then `corepack pnpm exec firebase --project PROJECT_ID hosting:disable`. The Firestore location cannot be changed; delete the project to remove the data (there is no TTL on Spark, so nothing expires by itself).
5. Clear your shell (`Remove-Item Env:QSTASH_TOKEN`) and delete the downloaded key file.

## 0. Blockers that cannot be solved by commands

1. **Images are defined but not built or pushed by anything automated.** `apps/api/Dockerfile` and `apps/worker/Dockerfile` exist (section F).
   CI builds both on every push and smoke-runs them, without pushing. Docker is not installed on the development machine, so no image was built locally;
   the owner builds, pushes and records the `sha256` digests. Nothing in the repository logs in to a registry or pushes.
2. **C1–C9 gate ADR-003/011/017 assumptions.** Run them (section D) before treating cloud behaviour as verified.
3. **Admin and demo data exist only as scripts that have never touched a real project:** `scripts/grant-role.mjs` and `scripts/seed-demo.mjs` (section G) were tested
   offline (unit, fake Auth/Firestore) and against the Firestore and Auth emulators only. The Identity Toolkit lookup with an owner token is unverified live.
4. **Owner decisions:** the demo project, billing, the irreversible Firestore region (section C), the Redis provider, and a license.

## Pre-flight (local, no cloud access)

```powershell
node scripts/preflight.mjs --config <secrets-dir>/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1
```

Reports `PASS` (verified locally), `FAIL` (repository inconsistency), `BLOCKED` (a local tool, artifact or configuration is missing) and `NOT RUN`
(external verification). It reads files and only the *names* of environment variables, never calls Google Cloud, and never prints values.
A green preflight does not mean any cloud resource exists or that C1–C9 passed. `--strict` also fails on `BLOCKED`; `--json` prints machine-readable output.

**Cloud read mode (opt-in, read-only) [repo].** Before and after each stage you can compare the real project with the plan. It uses your gcloud token and sends
**GET requests only**; a wrapper refuses any other method before it reaches the network. It reads the project first and stops on any identity doubt
(number, ACTIVE state, `queuepilot-environment=demo` label); then billing status, the ten APIs, the Firestore location and type, both image digests in Artifact Registry,
the pinned `redis-url` version **metadata** (never the payload), `qp-process` and `qp-reconcile` state, the Run images and their invoker IAM.

```powershell
node scripts/preflight.mjs --config <secrets-dir>/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1 --run --approve-project ACTUAL_DEMO_PROJECT
```

Statuses: `PASS` matches the plan; `FAIL` contradicts it or a safety rule (other Firestore region, running queue/job, public worker, other image); `ABSENT` not created yet
(expected before its stage); `UNKNOWN` denied or failed read, never counted as success. Exit 1 on FAIL, 3 on UNKNOWN, else 0. Budget alerts are not readable this way:
confirm them in the console. This mode has only been tested against mocked responses; it has never run against Google Cloud.

## A. Google Cloud project

1. Choose or create a dedicated **demo** project containing no production resources. Label it `queuepilot-environment=demo`.
   `infra/apply.mjs` and `scripts/shutdown.mjs` check this label and the exact project number before any write; `grant-role.mjs` and `seed-demo.mjs` check ACTIVE state and the label, and require `--project-number` for every cloud write. All refuse placeholder or `prod`-named projects.
2. Link billing yourself (the scripts never enable billing). Create a **budget with alerts** in the console first (Billing → Budgets).
   Instance and queue limits bound throughput, not money; they are not a hard cap.
3. Install gcloud yourself and log in with your normal short-lived login. Scripts take a short-lived token through gcloud and
   never persist or print it. No service-account keys are created.
4. Review organisation policies (public API access, service-account impersonation) and inherited IAM.
5. Region is fixed to `europe-west1` (ADR-007); the scripts reject any other region.
6. Copy `infra/config.example.json` **outside the repository** (for example `<secrets-dir>/cloud.json`) and set
   `projectId`, `projectNumber`, `redisSecretVersion` (a numeric pinned version) and, later, the two image digests. The config accepts
   only these keys; credentials and fault flags are rejected.
7. Print the plan; this uses no credentials or network **[repo]**:

```powershell
node infra/apply.mjs --config <secrets-dir>/cloud.json
```

Services enabled by the `bootstrap` stage: Resource Manager, Run, Tasks, Scheduler, Firestore, Firebase Rules, Secret Manager, IAM,
IAM Credentials, Artifact Registry.

```powershell
node infra/apply.mjs --config <secrets-dir>/cloud.json --stage bootstrap --apply --approve-project=ACTUAL_DEMO_PROJECT
```

Stages run in this order, one at a time, each reviewed: `bootstrap`, (owner secret/image gate), `data`, `queue`, `access`, `deploy`, `iam`, `scheduler`.
`--stage all` is refused.

**Guarded wrapper (recommended) [repo].** `scripts/deploy.mjs` is a front end for exactly one stage. Without `--apply` it prints a readable plan, warnings
(for example the irreversible Firestore location or the public API grant) and a *plan digest*, and uses no credentials or network. To apply, repeat the project,
the region and the digest you reviewed; it then delegates to `infra/apply.mjs`, whose own checks (project number, `queuepilot-environment=demo` label, Firestore
location consent, paused queue/job, pinned images) stay in force. The wrapper never resumes a queue or job.

```powershell
node scripts/deploy.mjs --config <secrets-dir>/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1 --stage bootstrap
node scripts/deploy.mjs --config <secrets-dir>/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1 --stage bootstrap `
  --apply --approve-project ACTUAL_DEMO_PROJECT --approve-region europe-west1 --approve-plan DIGEST_FROM_THE_PLAN
```

Extra approvals: `data` needs `--approve-firestore-location europe-west1`; `iam` needs `--approve-public-api` (it makes `qp-api` publicly invocable); `scheduler` creates
the job only with `--approve-b4-worker-image FULL_PINNED_WORKER_IMAGE`. Only `europe-west1` is accepted. Exit codes: 0 ok, 1 `infra/apply.mjs` failure, 2 usage, 3 refused, 4 state conflict, 5 I/O.
The direct `infra/apply.mjs` commands below are NOT equivalent to the wrapper: they do not include the `--approve-region`, `--approve-plan` and `--approve-public-api` gates, and
the `iam` stage can be applied through that path with `--approve-project` alone (no public-API consent). Use `scripts/deploy.mjs` for every real apply.

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
node infra/apply.mjs --config <secrets-dir>/cloud.json --stage data --apply --approve-project=ACTUAL_DEMO_PROJECT --approve-firestore-location=europe-west1
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
node infra/apply.mjs --config <secrets-dir>/cloud.json --stage queue --apply --approve-project=ACTUAL_DEMO_PROJECT
```

The queue (and later the Scheduler job) is created and kept **paused**. No script in this repository resumes either; resuming is the owner's explicit action in section I.

C1–C9 use isolated `qp-spike-*` resources and never touch `qp-process`. Follow [infra/CLOUD_VERIFICATION.md](../infra/CLOUD_VERIFICATION.md) exactly:
build the probe image from `scripts/spike/Dockerfile`, print `node scripts/spike/setup.mjs --config <secrets-dir>/spike.json`, apply stages
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

### C1–C9 control matrix (prepared, NOT RUN)

Every row runs in `ACTUAL_DEMO_PROJECT`, region `europe-west1`, on isolated `qp-spike-*` resources created by `scripts/spike/setup.mjs` (stages `identities, queues,
access, deploy, iam, scheduler`). It never touches `qp-process`, `qp-api`, `qp-worker` or their identities. Commands are `node scripts/spike/probe.mjs --config
<secrets-dir>/spike.json ... --run --approve-project=ACTUAL_DEMO_PROJECT` unless stated; exact arguments are in [infra/CLOUD_VERIFICATION.md](../infra/CLOUD_VERIFICATION.md).
Provisioning needs the owner provisioner permissions (infra/README.md); probes impersonate `qp-spike-reader` / `qp-spike-no-get` for 600 s through IAM Credentials.
Cost is a handful of Cloud Tasks operations, Cloud Run requests at 0–1 instance and at most 60 Redis PINGs; none of the steps is irreversible except that deleted queue
names may not be reusable for a while (reuse paused queues). Record each result in a copy of `infra/cloud-results.not-run.json`.

| Check | Command (probe actions) | Reads / writes | Pass criterion | If it fails / rollback |
|---|---|---|---|---|
| C1 getTask after completion | resume `qp-spike-semantics`; `--action create --case success`; then `--action get` every 5 s ≤ 60 s | creates 1 task; GET task | handler 200 with the run id, then an explicit `NOT_FOUND` | timeout or permission error = INCONCLUSIVE; pause the queue |
| C2 name dedup / tombstone | paused queue: create the same name twice; resume, complete, create again; create + owner delete + recreate another name | ≤ 4 tasks, 1 delete (owner identity) | `ALREADY_EXISTS` for the live, completed and deleted names; observed retention bounds recorded (docs: up to 24 h; ARCHITECTURE: about 1 h) | a single run proves no upper bound; observations past 1 h need separate approval. ADR-017 does not depend on the outcome |
| C3 delivery headers | compare allowlisted headers of the C1 delivery with a `409` or `fail` task's retries | 1 task | queue/task name, retry and execution counts and ETA observed; nothing else copied | headers are observations only, never a business attempt budget |
| C4 deletion rule (AND) | one `fail` task on `qp-spike-retry` (3 attempts < 120 s) and one on `qp-spike-slow` (130 s backoff); poll GET ≤ 10 min | 2 tasks | removal only when **both** attempts and duration are exhausted | contradiction blocks architecture acceptance: propose an ADR-003 fallback; pause queues |
| C5 409 / 429 | one `409` task, one handler `429` task; 2 + ≤ 4 `delay` tasks against the 1-instance probe for platform 429 | ≤ 6 tasks; temporary invoker grant to one approved caller | handler vs platform 429 told apart in Run logs; backoff observed | platform 429 not forced within 10 min = NOT RUN/INCONCLUSIVE, never PASS; remove the temporary grant |
| C6 OIDC on the private worker | unauthenticated call to `/probe/success/...`; Tasks OIDC delivery; one manual run of the paused `qp-spike-scheduler` | 1 task, 1 job run | 403 without token and no handler log; 200 for Tasks and Scheduler | re-pause the job; repeat on the real worker before acceptance |
| C7 Hosting forwards `Authorization` | temporary Hosting site from a local copy of `scripts/spike/firebase.json`; request `/api/auth-header` with and without a synthetic bearer | temporary Hosting site (separate deploy approval) | `authorizationForwarded:true` only with the header | disable/delete the temporary site |
| C8 Redis latency | owner adds the TLS secret version; POST `/redis` three times with short-lived OIDC | ≤ 60 PINGs; temporary invoker grant | 20 warm samples per repetition, p50/p95 per repetition recorded with provider region and plan | latency unsuitable → reconsider ADR-007/provider; remove the grant |
| C9 queue-scoped `tasks.get` | paused queue with a named task: get as reader, get as no-get; swap reader's binding to `qpEnqueuer`, get again, restore | queue IAM on `qp-spike-semantics` only | reader succeeds; no-get gives `PERMISSION_DENIED` → `PROBE_UNKNOWN`, never ABSENT; restored binding works | never widen to project level; restore by reapplying setup `access`; propose ADR-011 if scope fails |

Cloud Tasks semantics behind C1, C2 and C4 come from the public references
([tasks.get](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/get),
[tasks.create deduplication](https://docs.cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks/create),
[retry configuration](https://docs.cloud.google.com/tasks/docs/configuring-queues)); only the live run in the demo project counts as evidence.

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
   deliberately, then rerun CI); runs as the non-root `node` user over root-owned, read-only application files; `CMD ["node","dist/server.js"]` so SIGTERM reaches the process;
   no `.env`, key or credential is copied (`.dockerignore`). CI (`scripts/docker-smoke.mjs`, synthetic production-shaped settings from `scripts/lib/smoke-env.mjs`) proves only:
   the build succeeds; `/health` answers with `QP_ENV=production` settings; the worker rejects unauthenticated `/internal/*` calls with 403; quota fail-open, `QP_FAULT_*`,
   emulator overrides and demo projects each stop startup; `/app` holds only `package.json`, `node_modules` and `dist/server.js(.map)` with no workspace sources or `re2`;
   files are read-only; the user is non-root; SIGTERM exits 0. The images ran against real Firestore and Upstash Redis only in the single free-tier live run (B9-9, n=1, Render); they were never run against real Cloud Tasks.
2. Deploy, worker first then API, with explicit service identities **[repo]**:

```powershell
node infra/apply.mjs --config <secrets-dir>/cloud.json --stage access --apply --approve-project=ACTUAL_DEMO_PROJECT
node infra/apply.mjs --config <secrets-dir>/cloud.json --stage deploy --apply --approve-project=ACTUAL_DEMO_PROJECT
node infra/apply.mjs --config <secrets-dir>/cloud.json --stage iam --apply --approve-project=ACTUAL_DEMO_PROJECT
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
   `tenants/sandbox` exists with `openSignup=true`. The infra scripts do not create tenants or memberships, so seed the tenant first **[repo]**. Both scripts write only
   with `--apply` plus `--approve-project` repeating the exact project ID; they use your own `gcloud auth login` token, never a key file:

```powershell
# 1. Create tenants/sandbox only (create-only; reruns report "unchanged"; a different existing document is reported as DRIFT with the
#    differing field names and never overwritten). The sign-up choice is mandatory. The dry run uses no credentials or network.
node scripts/seed-demo.mjs --project ACTUAL_DEMO_PROJECT --open-signup true
node scripts/seed-demo.mjs --project ACTUAL_DEMO_PROJECT --open-signup true --apply --approve-project ACTUAL_DEMO_PROJECT --project-number ACTUAL_PROJECT_NUMBER
# 2. Sign in once with Google in the deployed UI (bootstrap creates your member membership and the Auth account the next step checks).
# 3. Dry run (read-only, needs gcloud login): resolves the user by email or uid, checks the account and prints the uid to approve.
node scripts/grant-role.mjs --project ACTUAL_DEMO_PROJECT --tenant sandbox --email YOUR_GOOGLE_EMAIL
# 4. Apply with the uid printed by step 3 (the only supported way to create an admin).
node scripts/grant-role.mjs --project ACTUAL_DEMO_PROJECT --tenant sandbox --email YOUR_GOOGLE_EMAIL `
  --apply --approve-project ACTUAL_DEMO_PROJECT --approve-uid UID_PRINTED_BY_THE_DRY_RUN --project-number ACTUAL_PROJECT_NUMBER
```

   `seed-demo.mjs` never creates memberships or admins. `grant-role.mjs` resolves the account through the Identity Toolkit `accounts:lookup` read (needs
   `firebaseauth.users.get`; your project is sent as quota project) and refuses unless exactly one account matches, it is enabled, its email is verified and it has a
   `google.com` provider. It prints the email masked. It requires the tenant to exist and be active, refuses to move a user between tenants or to reactivate a suspended
   membership, accepts one explicit tenant and one user (no wildcards), never changes custom claims or IAM, and the API caches memberships for up to 30 s, so the role
   takes effect within that time. Both verify the project exists, is ACTIVE and carries the
   `queuepilot-environment=demo` label before writing, and refuse a cloud write without `--project-number` matching the project. Exit codes: 0 ok, 2 usage, 3 refused, 4 state conflict, 5 I/O. With `open-signup true`, anyone with a Google login can join
   `sandbox`; choose `false` to keep sign-up closed until you are ready. Sign-up quotas for `sandbox` are `10/min/user, 30/day/user, 2000/day` (ARCHITECTURE §15) and fail
   closed when Redis is unavailable. **Never run these against a real project until you have reviewed the dry-run output.**

## H. Rollback and shutdown

Order matters: stop new work, then inspect, then remove. Pause does **not** cancel in-flight requests.

1. Pause the Scheduler job and then the queue **[repo]**. `scripts/shutdown.mjs` is dry-run by default; with `--apply` it checks the project (ACTIVE, demo label, project number),
   pauses `qp-reconcile` then `qp-process` through the existing `ensurePaused` code and requires a read-back of `PAUSED`. It never deletes or resumes anything:

```powershell
node scripts/shutdown.mjs --config <secrets-dir>/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1
node scripts/shutdown.mjs --config <secrets-dir>/cloud.json --project ACTUAL_DEMO_PROJECT --region europe-west1 `
  --apply --approve-project ACTUAL_DEMO_PROJECT --approve-region europe-west1
```

   Optional and separate: `--revoke-public-api` also removes the `allUsers` `roles/run.invoker` binding from `qp-api` (only that member, only in unconditional
   invoker bindings, sent with the policy etag and confirmed by a re-read). A conditional or `allAuthenticatedUsers` invoker binding is never edited; it is reported as an error for you to review. The public API and the Hosting rewrite then stop serving; re-run the `iam` stage to expose it again.
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
