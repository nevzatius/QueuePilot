import { validateConfig, specification } from '../../infra/spec.mjs';

// Deterministic, local-only deployment preflight. It reads repository files and (by name only) the
// environment. It never calls GCP, never prints environment values and can only report what is
// verifiable offline: PASS (verified locally), FAIL (repository inconsistency), BLOCKED (a local
// tool, artifact or configuration is missing) and NOT_RUN (external verification, not executed).

export const REQUIRED_FILES = [
  'apps/api/Dockerfile', 'apps/worker/Dockerfile', '.dockerignore', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'infra/apply.mjs', 'infra/cloud.mjs', 'infra/spec.mjs', 'infra/config.example.json', 'infra/CLOUD_VERIFICATION.md',
  'scripts/deploy.mjs', 'scripts/shutdown.mjs', 'scripts/grant-role.mjs', 'scripts/seed-demo.mjs',
  'docs/DEPLOYMENT_RUNBOOK.md', 'docs/ARCHITECTURE.md', '.github/workflows/ci.yml',
];
export const ROOT_SCRIPTS = ['lint', 'typecheck', 'test', 'build', 'test:integration'];
export const APP_SCRIPTS = ['build', 'start'];
export const NOT_RUN_ITEMS = [
  'GCP verification C1-C9 (infra/CLOUD_VERIFICATION.md)',
  'Any actual cloud deployment or resource existence (project, Firestore, queue, Cloud Run, Scheduler)',
  'Live Cloud Tasks / Cloud Run behaviour (OIDC delivery, dispatch deadline, queue-level IAM)',
  'Real Google OAuth sign-in and Firebase authorized domains',
  'Upstash / TLS Redis (rediss://) latency and fail-closed behaviour',
  'Cloud load tests',
];
const SECRET_NAME_PATTERN = /(secret|token|password|private[_-]?key|credential)\w*\s*[=:]/i;

export function runPreflight(ctx) {
  const results = [];
  const add = (id, status, detail, required = true) => results.push({ id, status, detail, required });
  const { read, exists, env, tool, args } = ctx;
  const json = (path) => { try { return JSON.parse(read(path)); } catch { return null; } };

  // 1. Files
  const missing = REQUIRED_FILES.filter((file) => !exists(file));
  add('repo-files', missing.length ? 'FAIL' : 'PASS', missing.length ? `missing: ${missing.join(', ')}` : `${REQUIRED_FILES.length} required files present`);

  // 2. Package scripts and engines
  const rootPackage = json('package.json');
  const lacking = ROOT_SCRIPTS.filter((name) => !rootPackage?.scripts?.[name]);
  for (const app of ['api', 'worker']) {
    const manifest = json(`apps/${app}/package.json`);
    for (const name of APP_SCRIPTS) if (!manifest?.scripts?.[name]) lacking.push(`${app}:${name}`);
  }
  add('package-scripts', lacking.length ? 'FAIL' : 'PASS', lacking.length ? `missing scripts: ${lacking.join(', ')}` : 'root and app scripts present');
  add('engines', rootPackage?.engines?.node === '>=24 <25' && /^pnpm@10\./.test(rootPackage?.packageManager ?? '') ? 'PASS' : 'FAIL',
    'package.json engines node ">=24 <25" and pinned pnpm 10');

  // 3. Dockerfiles
  const dockerfiles = Object.fromEntries(['api', 'worker'].map((app) => [app, exists(`apps/${app}/Dockerfile`) ? read(`apps/${app}/Dockerfile`) : '']));
  const image = (text) => /^ARG NODE_IMAGE=(node:24\.\d+\.\d+-[a-z0-9.-]+@sha256:[a-f0-9]{64})$/m.exec(text)?.[1];
  const problems = [];
  for (const [app, text] of Object.entries(dockerfiles)) {
    if (!image(text)) problems.push(`${app}: base image must be node:24.x.y-<variant>@sha256:<digest>`);
    if (!/^USER node$/m.test(text)) problems.push(`${app}: no non-root USER`);
    if (!/^CMD \["node", "dist\/server\.js"\]$/m.test(text)) problems.push(`${app}: CMD must be exec-form node (SIGTERM)`);
    if (!/--frozen-lockfile/.test(text)) problems.push(`${app}: install must use --frozen-lockfile`);
    if (!/\/health/.test(text)) problems.push(`${app}: HEALTHCHECK should use /health`);
    if (/^(ENV|ARG)\s+\S*(SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL)\S*=/im.test(text) || /COPY[^\n]*\.env/i.test(text) || SECRET_NAME_PATTERN.test(text.replace(/^#.*$/gm, ''))) {
      problems.push(`${app}: possible secret or env file in image definition`);
    }
  }
  if (image(dockerfiles.api) !== image(dockerfiles.worker)) problems.push('api and worker use different base images');
  const ignore = exists('.dockerignore') ? read('.dockerignore') : '';
  for (const needle of ['**/.env', '**/node_modules', '.git']) if (!ignore.split('\n').includes(needle)) problems.push(`.dockerignore lacks ${needle}`);
  for (const required of ['pnpm-lock.yaml', 'package.json']) if (ignore.split('\n').includes(required)) problems.push(`.dockerignore excludes ${required}`);
  add('dockerfiles', problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : 'pinned Node 24 base, non-root, exec-form CMD, frozen lockfile, /health, no secrets');

  // 4. CI image job never pushes
  const workflow = exists('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : '';
  const buildsImages = /docker build -f apps\/\$\{\{ matrix\.app \}\}\/Dockerfile/.test(workflow);
  const publishes = /docker\/login-action|docker push|--push|push:\s*true|gcloud |google-github-actions|firebase deploy/i.test(workflow);
  add('ci-images', buildsImages && !publishes ? 'PASS' : 'FAIL', buildsImages ? (publishes ? 'workflow contains a push/login/deploy construct' : 'CI builds both images, no push, no cloud tooling') : 'CI does not build the images');

  // 5. Config keys used by infra exist in application config; region consistency
  const configSource = exists('packages/core/src/config.ts') ? read('packages/core/src/config.ts') : '';
  const example = json('infra/config.example.json');
  let envKeys = [];
  let regionOk = false;
  try {
    const spec = specification(example);
    envKeys = spec.find((r) => r.id === 'qp-api').body.template.containers[0].env.map((entry) => entry.name);
    regionOk = /QP_REGION: z\.string\(\)[^\n]*\.default\('europe-west1'\)/.test(configSource) && example.region === 'europe-west1';
  } catch { /* reported below */ }
  const unknownKeys = envKeys.filter((key) => !new RegExp(`\\b${key}\\b`).test(configSource));
  add('config-consistency', envKeys.length && !unknownKeys.length && regionOk ? 'PASS' : 'FAIL',
    envKeys.length ? (unknownKeys.length ? `infra env keys unknown to packages/core config: ${unknownKeys.join(', ')}` : `${envKeys.length} infra env keys exist in app config; region europe-west1 consistent`) : 'could not derive deploy env from infra/spec.mjs');

  // 6. Nothing in the tooling resumes queues or jobs
  const tooling = ['infra/apply.mjs', 'infra/cloud.mjs', 'infra/spec.mjs', 'scripts/deploy.mjs', 'scripts/shutdown.mjs'].filter(exists).map(read).join('\n');
  add('paused-defaults', /:resume\b/.test(tooling) ? 'FAIL' : (/ensurePaused/.test(tooling) ? 'PASS' : 'FAIL'),
    'text check only: tooling pauses via ensurePaused and contains no resume call (resume is an owner action; real behaviour is unverified until C-checks)');

  // 7. No key files in the tree (names only)
  const keyFiles = ctx.listFiles().filter((file) => /(^|\/)(service-account[^/]*\.json|[^/]*-credentials\.json|\.env(\.[^/]+)?(?<!\.example)|[^/]+\.(pem|p12|pfx|key))$/i.test(file));
  add('no-key-files', keyFiles.length ? 'FAIL' : 'PASS', keyFiles.length ? `credential-like files present: ${keyFiles.join(', ')}` : 'no credential-like files in the working tree');

  // 8. Build artifacts and tools (BLOCKED = something local is missing)
  for (const app of ['api', 'worker']) {
    add(`artifact-${app}`, exists(`apps/${app}/dist/server.js`) ? 'PASS' : 'BLOCKED', exists(`apps/${app}/dist/server.js`) ? `apps/${app}/dist/server.js present` : 'run `pnpm build`', false);
  }
  const major = Number(/^v?(\d+)/.exec(ctx.nodeVersion)?.[1]);
  add('tool-node', major === 24 ? 'PASS' : 'BLOCKED', `Node ${major === 24 ? '24.x' : 'is not 24.x (engines require >=24 <25)'}`, false);
  add('tool-docker', tool('docker') ? 'PASS' : 'BLOCKED', tool('docker') ? 'docker found (image build possible locally)' : 'docker not installed: images are built only in CI', false);
  add('tool-gcloud', tool('gcloud') ? 'PASS' : 'BLOCKED', tool('gcloud') ? 'gcloud found (needed by the owner for apply)' : 'gcloud not installed: required only for owner apply/shutdown', false);

  // 9. Supplied arguments and configuration
  if (args.config) {
    const config = args.configText === undefined ? null : (() => { try { return JSON.parse(args.configText); } catch { return null; } })();
    let status = 'PASS';
    let detail = 'configuration valid';
    try {
      if (!config) throw new Error('configuration unreadable or not JSON');
      validateConfig(config, false, false);
      if (args.project && config.projectId !== args.project) throw new Error('--project differs from configuration');
      if (args.region && config.region !== args.region) throw new Error('--region differs from configuration');
      if (config.projectId.startsWith('replace-')) { status = 'BLOCKED'; detail = 'placeholder project ID: replace it before any apply'; }
    } catch (error) { status = 'FAIL'; detail = error.message; }
    add('config-file', status, detail, false);
  } else {
    add('config-file', 'BLOCKED', 'no --config supplied: only repository checks ran (project/region/secret-version not checked)', false);
  }
  if (args.region && args.region !== 'europe-west1') add('region-arg', 'FAIL', 'only europe-west1 is approved (irreversible Firestore location, ADR-007)');
  // Secrets are reported by NAME only; values are never read into output.
  // REDIS_URL matters only for local real-Redis runs; deployed services read Secret Manager instead.
  add('env-REDIS_URL', env.REDIS_URL ? 'PASS' : 'BLOCKED', `REDIS_URL is ${env.REDIS_URL ? 'set' : 'not set'} in this shell (value not shown; needed only for local real-Redis runs)`, false);
  add('cloud-secret-redis-url', 'NOT_RUN', 'Secret Manager secret redis-url and its pinned version cannot be verified locally', false);

  for (const item of NOT_RUN_ITEMS) add(`not-run:${item.split(' ')[0].toLowerCase()}`, 'NOT_RUN', item, false);
  return results;
}

export function summarize(results, strict = false) {
  const failed = results.some((r) => r.status === 'FAIL');
  const blocked = results.some((r) => r.status === 'BLOCKED' && (r.required || strict));
  return { failed, blocked, exitCode: failed ? 1 : blocked ? 2 : 0 };
}
