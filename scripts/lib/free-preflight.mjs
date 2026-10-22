import { isTimeout } from './qstash.mjs';
import { BlueprintSyntaxError, parseBlueprint } from './render-yaml.mjs';

// Free-tier profile of the local preflight (ADR-019, `preflight.mjs --profile free`). Text and structure checks of the
// repository files only: render.yaml, firebase.json, .firebaserc, the Firestore rules and the app entry points. It
// reads no environment value except the NAME-level TRUST_PROXY_HOPS / adapter pair for one warning, and never calls
// a network. PASS here means "the files agree with each other and with the guards", not "the services exist".

export const FREE_FILES = ['render.yaml', 'firebase.json', '.firebaserc', 'infra/firestore.rules', 'infra/firestore.indexes.free.json',
  'scripts/qstash-setup.mjs', 'scripts/qstash-shutdown.mjs', 'scripts/lib/qstash.mjs', 'apps/web/package.json'];

/** Declared secrets: must be `sync: false`, never a value in the file. */
export const SECRET_ENV = ['QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'REDIS_URL', 'QP_FIREBASE_SERVICE_ACCOUNT_JSON'];
const SECRET_LIKE = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|SIGNING_KEY|PRIVATE_KEY|_JSON$|REDIS_URL)/i;
const SERVICE_KEYS = ['type', 'name', 'runtime', 'plan', 'region', 'dockerfilePath', 'dockerContext', 'healthCheckPath', 'autoDeployTrigger', 'envVars'];
const SERVICES = { 'queuepilot-api': 'api', 'queuepilot-worker': 'worker' };
const FORBIDDEN_ENV = [/^QP_REGION$/, /^QP_TASKS_/, /^QP_SCHEDULER_SA$/, /EMULATOR/, /^GOOGLE_APPLICATION_CREDENTIALS$/, /^QP_FAULT_/, /^VITE_/, /^PORT$/];
const COMMON_ENV = ['QP_ENV', 'QP_QUEUE_ADAPTER', 'QP_WORKER_AUTH_MODE', 'GCLOUD_PROJECT', 'QP_WORKER_URL', 'QSTASH_URL', ...SECRET_ENV];
const REQUIRED_ENV = { api: [...COMMON_ENV, 'TRUST_PROXY_HOPS', 'QP_CORS_ORIGINS'], worker: COMMON_ENV };
const FORBIDDEN_FIREBASE_KEYS = ['functions', 'storage', 'extensions', 'dataconnect', 'apphosting', 'database', 'remoteconfig'];

const isHttpsOrigin = (value) => typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:' && new URL(value).origin === value;
const isLoopback = (value) => /^https?:\/\/(localhost|127\.|\[::1\])/i.test(value);
/** The deny-all rules, whitespace-normalised and without comments. The check is equality, not a pattern. */
export const CANONICAL_RULES = "rules_version = '2'; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if false; } } }";
export const normalizeRules = (text) => text.replace(/\/\/.*$/gm, '').replace(/\s+/g, ' ').trim();
/** The Hosting header values the SPA shell needs; Permissions-Policy only has to be present. */
const SHELL_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin-allow-popups', 'cache-control': 'no-cache' };
const headerValue = (rule, key) => (rule?.headers ?? []).find((h) => typeof h?.key === 'string' && h.key.toLowerCase() === key)?.value;
/** True when a `ttl` key anywhere in the parsed indexes file is not strictly false: TTL deletes need the Blaze plan. */
const hasTtl = (node) => (Array.isArray(node) ? node.some(hasTtl) : node !== null && typeof node === 'object'
  && Object.entries(node).some(([key, value]) => (key === 'ttl' && value !== false) || hasTtl(value)));
const stripComments = (text) => text.split(/\r?\n/).map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n');

/** Value-level problems of one env entry, by name (never the value). */
function envProblems(service, entry) {
  const problems = [];
  const where = `${service}.${entry.key}`;
  for (const field of Object.keys(entry)) if (!['key', 'value', 'sync'].includes(field)) problems.push(`${where}: unsupported field ${field}`);
  const hasValue = Object.hasOwn(entry, 'value');
  if (hasValue === Object.hasOwn(entry, 'sync')) problems.push(`${where}: exactly one of value or "sync: false" is required`);
  if (Object.hasOwn(entry, 'sync') && entry.sync !== false) problems.push(`${where}: sync must be false`);
  if ((SECRET_ENV.includes(entry.key) || SECRET_LIKE.test(entry.key)) && (hasValue || entry.sync !== false)) problems.push(`${where}: a secret must be "sync: false" with no value`);
  if (hasValue) {
    const { value } = entry;
    if (typeof value !== 'string') problems.push(`${where}: the value must be a quoted string`);
    else if (/rediss?:\/\/[^\s/@]*@/.test(value) || /-----BEGIN/.test(value) || /^[A-Za-z0-9+/_=-]{32,}$/.test(value)) problems.push(`${where}: the value looks like a credential`);
  }
  return problems;
}

function checkServices(blueprint, read, exists) {
  const problems = [];
  const extra = Object.keys(blueprint).filter((key) => key !== 'services');
  if (extra.length) problems.push(`top-level keys other than services are not allowed (${extra.join(', ')}): databases, key-value stores and env groups are not part of the free path`);
  const services = Array.isArray(blueprint.services) ? blueprint.services : [];
  if (services.map((s) => s?.name).sort().join() !== Object.keys(SERVICES).sort().join()) problems.push(`services must be exactly ${Object.keys(SERVICES).join(' and ')}`);
  const urls = new Set();
  for (const service of services) {
    const role = SERVICES[service?.name];
    if (!role) continue;
    const name = service.name;
    for (const key of Object.keys(service)) if (!SERVICE_KEYS.includes(key)) problems.push(`${name}: unsupported key ${key} (disks, scaling and other add-ons are paid)`);
    const expect = { type: 'web', runtime: 'docker', plan: 'free', region: 'frankfurt', healthCheckPath: '/health', autoDeployTrigger: 'off',
      dockerfilePath: `./apps/${role}/Dockerfile`, dockerContext: '.' };
    for (const [key, wanted] of Object.entries(expect)) if (service[key] !== wanted) problems.push(`${name}: ${key} must be ${JSON.stringify(wanted)}`);
    if (!exists(`apps/${role}/Dockerfile`)) problems.push(`${name}: ${expect.dockerfilePath} does not exist`);
    const envVars = Array.isArray(service.envVars) ? service.envVars : [];
    const byName = new Map();
    for (const entry of envVars) {
      if (!entry || typeof entry.key !== 'string') { problems.push(`${name}: an env entry has no key`); continue; }
      if (byName.has(entry.key)) problems.push(`${name}.${entry.key}: declared twice`);
      byName.set(entry.key, entry);
      if (FORBIDDEN_ENV.some((pattern) => pattern.test(entry.key))) problems.push(`${name}.${entry.key}: not allowed on the free path (Cloud Tasks, emulator, fault, web or platform-owned setting)`);
      problems.push(...envProblems(name, entry));
    }
    for (const key of REQUIRED_ENV[role]) if (!byName.has(key)) problems.push(`${name}: ${key} is missing`);
    const valueOf = (key) => byName.get(key)?.value;
    for (const [key, wanted] of [['QP_ENV', 'production'], ['QP_QUEUE_ADAPTER', 'qstash'], ['QP_WORKER_AUTH_MODE', 'qstash']]) {
      if (valueOf(key) !== wanted) problems.push(`${name}: ${key} must be ${wanted}`);
    }
    if (role === 'api' && valueOf('TRUST_PROXY_HOPS') !== '3') problems.push(`${name}: TRUST_PROXY_HOPS must be "3" (Render appends three hops, ADR-019)`);
    if (role === 'worker' && byName.has('TRUST_PROXY_HOPS')) problems.push(`${name}: TRUST_PROXY_HOPS is an API-only setting`);
    if (role === 'worker' && byName.has('QP_CORS_ORIGINS')) problems.push(`${name}: QP_CORS_ORIGINS is an API-only setting`);
    const project = valueOf('GCLOUD_PROJECT');
    if (project !== undefined && (!/^[a-z][a-z0-9-]{4,62}$/.test(project) || project.startsWith('demo-'))) problems.push(`${name}: GCLOUD_PROJECT must be a real project id, not demo-*`);
    const worker = valueOf('QP_WORKER_URL');
    if (worker !== undefined) { urls.add(worker); if (!isHttpsOrigin(worker) || isLoopback(worker)) problems.push(`${name}: QP_WORKER_URL must be an https origin`); }
    const qstashUrl = valueOf('QSTASH_URL');
    if (qstashUrl !== undefined && !isHttpsOrigin(qstashUrl)) problems.push(`${name}: QSTASH_URL must be an https origin`);
    const cors = valueOf('QP_CORS_ORIGINS');
    if (cors !== undefined && !(typeof cors === 'string' && cors.split(',').every((origin) => isHttpsOrigin(origin.trim()) && !isLoopback(origin.trim())))) {
      problems.push(`${name}: QP_CORS_ORIGINS must list exact https origins (no wildcard, no localhost)`);
    }
    if (valueOf('QP_QSTASH_RETRIES') !== undefined && !/^[0-3]$/.test(valueOf('QP_QSTASH_RETRIES'))) problems.push(`${name}: QP_QSTASH_RETRIES must be 0 to 3`);
    if (valueOf('QP_QSTASH_TIMEOUT') !== undefined && !isTimeout(String(valueOf('QP_QSTASH_TIMEOUT')))) problems.push(`${name}: QP_QSTASH_TIMEOUT must be a Go duration with a unit, 60s to 15m`);
    const configSource = exists('packages/core/src/config.ts') ? read('packages/core/src/config.ts') : '';
    const unknown = [...byName.keys()].filter((key) => !new RegExp(`\\b${key}\\b`).test(configSource));
    if (unknown.length) problems.push(`${name}: env keys unknown to packages/core config: ${unknown.join(', ')}`);
  }
  if (urls.size > 1) problems.push('the two services disagree on QP_WORKER_URL');
  return problems;
}

export function runFreePreflight(ctx, add) {
  const { read, exists, env } = ctx;
  const json = (path) => { try { return JSON.parse(read(path)); } catch { return null; } };

  const missing = FREE_FILES.filter((file) => !exists(file));
  add('free-files', missing.length ? 'FAIL' : 'PASS', missing.length ? `missing: ${missing.join(', ')}` : `${FREE_FILES.length} free-profile files present`);

  // render.yaml
  let blueprint = null;
  let renderText = '';
  if (exists('render.yaml')) {
    renderText = read('render.yaml');
    try { blueprint = parseBlueprint(renderText); } catch (error) { add('free-render-syntax', 'FAIL', error instanceof BlueprintSyntaxError ? error.message : 'render.yaml cannot be read'); }
  }
  if (blueprint) {
    add('free-render-syntax', 'PASS', 'render.yaml parses (strict subset reader)');
    const problems = checkServices(blueprint, read, exists);
    // Quotes are dropped first, so `plan: "starter"` is seen and `plan: "free"` is accepted.
    if (/^[ \t]*-?[ \t]*plan:[ \t]*(?!free[ \t]*$)\S/m.test(stripComments(renderText).replace(/["']/g, ''))) problems.push('a plan other than free appears in the file');
    add('free-render', problems.length ? 'FAIL' : 'PASS',
      problems.length ? problems.join('; ') : 'two free Docker web services in Frankfurt, autoDeployTrigger off, /health, qstash adapter and auth, TRUST_PROXY_HOPS 3, no Cloud Tasks/emulator/QP_REGION, every secret sync:false');
  }

  // Port wiring: Render injects PORT, the apps must read it and listen on all interfaces.
  const entry = (app) => (exists(`apps/${app}/src/index.ts`) ? read(`apps/${app}/src/index.ts`) : '');
  const wiring = ['api', 'worker'].filter((app) => !/host:\s*'0\.0\.0\.0'/.test(entry(app)) || !/port:\s*config\.PORT/.test(entry(app)));
  add('free-port-wiring', wiring.length ? 'FAIL' : 'PASS', wiring.length ? `${wiring.join(', ')}: must listen on 0.0.0.0 at config.PORT` : 'both apps listen on 0.0.0.0 at the PORT that Render injects');

  // firebase.json, rules, .firebaserc
  const firebase = json('firebase.json');
  const problems = [];
  if (!firebase) problems.push('firebase.json is not valid JSON');
  else {
    for (const key of Object.keys(firebase)) if (!['firestore', 'hosting', 'emulators'].includes(key)) problems.push(`unsupported top-level key ${key}`);
    for (const key of FORBIDDEN_FIREBASE_KEYS) if (key in firebase) problems.push(`${key} needs the Blaze plan`);
    const hosting = firebase.hosting ?? {};
    if (hosting.public !== 'apps/web/dist') problems.push('hosting.public must be apps/web/dist');
    const rewrites = Array.isArray(hosting.rewrites) ? hosting.rewrites : [];
    if (!rewrites.some((rule) => rule.source === '**' && rule.destination === '/index.html')) problems.push('hosting needs the SPA rewrite ** -> /index.html');
    if (rewrites.some((rule) => 'run' in rule || 'function' in rule || 'functions' in rule || 'dynamicLinks' in rule)) problems.push('a Cloud Run or Functions rewrite needs the Blaze plan');
    const headerRules = Array.isArray(hosting.headers) ? hosting.headers : [];
    const shell = headerRules.find((rule) => rule?.source === '**');
    if (!shell) problems.push('hosting needs a "**" header rule (security headers and Cache-Control: no-cache for the SPA shell)');
    else {
      for (const [key, wanted] of Object.entries(SHELL_HEADERS)) if (headerValue(shell, key) !== wanted) problems.push(`hosting header ${key} on ** must be ${wanted}`);
      if (headerValue(shell, 'permissions-policy') === undefined) problems.push('hosting header permissions-policy on ** is missing');
    }
    // Cache-Control belongs on ** (no-cache, so a redeploy is never stale) and, for hashed files only, on /assets/** (immutable).
    // Hosting documents that matching rules apply "in the order they are defined" but not which wins for the same header,
    // so /assets/** must come after ** (B9-9 live check confirms the winner).
    for (const rule of headerRules) {
      if (rule?.source !== '**' && rule?.source !== '/assets/**' && headerValue(rule, 'cache-control') !== undefined) problems.push(`hosting: Cache-Control may only be set on ** and /assets/** (found on ${JSON.stringify(rule?.source)})`);
    }
    const assets = headerRules.find((rule) => rule?.source === '/assets/**');
    if (assets) {
      if (!/immutable/.test(String(headerValue(assets, 'cache-control')))) problems.push('hosting: /assets/** must set an immutable Cache-Control');
      if (shell && headerRules.indexOf(assets) < headerRules.indexOf(shell)) problems.push('hosting: the /assets/** rule must come after the ** rule');
    }
    for (const rule of ['rules', 'indexes']) {
      const file = firebase.firestore?.[rule];
      if (typeof file !== 'string' || !exists(file)) problems.push(`firestore.${rule} must name an existing file`);
    }
    const indexesPath = firebase.firestore?.indexes;
    if (typeof indexesPath === 'string' && exists(indexesPath)) {
      const indexes = json(indexesPath);
      if (indexes === null) problems.push(`${indexesPath} is not valid JSON`);
      else if (hasTtl(indexes)) problems.push(`${indexesPath} contains a ttl override: Firestore TTL deletes need billing (use infra/firestore.indexes.free.json; expiry stays logical, ADR-005)`);
    }
    const emulators = firebase.emulators ?? {};
    for (const name of ['auth', 'firestore']) if (emulators[name]?.host !== '127.0.0.1') problems.push(`emulator ${name} must stay on 127.0.0.1`);
  }
  const rulesPath = typeof firebase?.firestore?.rules === 'string' ? firebase.firestore.rules : 'infra/firestore.rules';
  if (!exists(rulesPath) || normalizeRules(read(rulesPath)) !== CANONICAL_RULES) problems.push(`${rulesPath} must stay exactly the deny-all rules (the Admin SDK bypasses rules)`);
  add('free-firebase', problems.length ? 'FAIL' : 'PASS', problems.length ? problems.join('; ') : 'firebase.json: SPA Hosting with security and cache headers, no Functions/Storage/Cloud Run rewrite, deny-all rules unchanged, emulators loopback-only');

  const rc = json('.firebaserc');
  const projectId = rc?.projects?.default;
  if (typeof projectId !== 'string') add('free-firebaserc', 'FAIL', '.firebaserc needs projects.default');
  else if (projectId.startsWith('replace-')) add('free-firebaserc', 'BLOCKED', 'placeholder Firebase project id in .firebaserc (expected before setup): leave the file as it is and pass --project PROJECT_ID to every firebase command', false);
  else add('free-firebaserc', projectId.startsWith('demo-') ? 'FAIL' : 'PASS', projectId.startsWith('demo-') ? '.firebaserc points at a demo-* project' : '.firebaserc names a project (existence not checked)');

  // Warning: under qstash every client shares the socket address in the bootstrap IP limiter when no hop is trusted.
  const hops = env.TRUST_PROXY_HOPS;
  const hopsUnset = hops === undefined || hops.trim() === '' || hops.trim() === '0';
  if (env.QP_QUEUE_ADAPTER === 'qstash' && hopsUnset) {
    add('free-trust-proxy-hops', 'WARN', 'QP_QUEUE_ADAPTER is qstash but TRUST_PROXY_HOPS is 0 or unset in this shell: behind Render every client would share one address in the bootstrap IP limiter. render.yaml sets 3 for the API; do not override it.', false);
  }
}
