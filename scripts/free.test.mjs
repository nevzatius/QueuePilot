import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, ScriptError } from './lib/ops.mjs';
import { runPreflight, summarize } from './lib/preflight.mjs';
import { SECRET_ENV } from './lib/free-preflight.mjs';
import { BlueprintSyntaxError, parseBlueprint } from './lib/render-yaml.mjs';
import { preflightMain } from './preflight.mjs';
import { DEFAULT_TENANT_DAILY_LIMIT, FREE_TENANT_DAILY_LIMIT, parseSeedArgs, sandboxTenant, seedDemo } from './seed-demo.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
// Checkouts may be CRLF (core.autocrlf); mutations below are written with LF.
const real = (path) => readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n');
const refuses = (fn, exitCode) => assert.throws(fn, (error) => error instanceof ScriptError && error.exitCode === exitCode, `expected exit ${exitCode}`);

// ---- render.yaml, firebase.json and .firebaserc are syntactically valid ----
test('render.yaml parses with the strict reader and has the expected shape', () => {
  const blueprint = parseBlueprint(real('render.yaml'));
  assert.deepEqual(Object.keys(blueprint), ['services']);
  assert.deepEqual(blueprint.services.map((s) => s.name), ['queuepilot-api', 'queuepilot-worker']);
  for (const service of blueprint.services) {
    assert.deepEqual([service.type, service.runtime, service.plan, service.region, service.autoDeploy, service.healthCheckPath], ['web', 'docker', 'free', 'frankfurt', false, '/health']);
  }
});

test('firebase.json and .firebaserc are valid JSON', () => {
  const firebase = JSON.parse(real('firebase.json'));
  assert.deepEqual(Object.keys(firebase).sort(), ['emulators', 'firestore', 'hosting']);
  assert.equal(firebase.hosting.public, 'apps/web/dist');
  assert.match(JSON.parse(real('.firebaserc')).projects.default, /^replace-/); // a placeholder, never a real id
});

test('the strict YAML reader accepts CRLF and refuses what it cannot read faithfully', () => {
  const text = real('render.yaml');
  assert.deepEqual(parseBlueprint(text.replace(/\r?\n/g, '\r\n')), parseBlueprint(text));
  assert.equal(parseBlueprint('a: 1\nb: "1"\nc: yes\nd: true\n').a, 1); // unquoted integers stay numbers, so the preflight can flag them
  for (const bad of ['a:\n\tb: 1', 'a: [1, 2]', 'a: {b: 1}', 'a: &x 1', 'a: |\n  text', 'a: 1\na: 2', 'a: 1\n  b: 2', '---\na: 1', 'a: "x\\ny"', 'a: "unterminated', '- a\nb: 1']) {
    assert.throws(() => parseBlueprint(bad), BlueprintSyntaxError, JSON.stringify(bad));
  }
});

// ---- free preflight ----
const ctxFor = (overrides = {}, env = {}) => ({
  read: (path) => (path in overrides ? overrides[path] : real(path)),
  exists: (path) => (path in overrides ? overrides[path] !== null : existsSync(join(root, path))),
  listFiles: () => [], env, tool: () => false, nodeVersion: 'v24.18.0', args: { profile: 'free' },
});
const free = (overrides, env) => runPreflight(ctxFor(overrides, env));
const status = (results, id) => results.find((r) => r.id === id)?.status;
const render = (mutate) => ({ 'render.yaml': mutate(real('render.yaml')) });
const firebase = (mutate) => ({ 'firebase.json': JSON.stringify(mutate(JSON.parse(real('firebase.json'))), null, 2) });

test('free preflight: the repository files pass, the placeholder project id is the only blocker, nothing live is claimed', () => {
  const results = free();
  assert.deepEqual(results.filter((r) => r.status === 'FAIL'), []);
  for (const id of ['free-files', 'free-render-syntax', 'free-render', 'free-port-wiring', 'free-firebase']) assert.equal(status(results, id), 'PASS', id);
  assert.equal(status(results, 'free-firebaserc'), 'BLOCKED');
  assert.equal(summarize(results).exitCode, 0); // the placeholder is an optional prerequisite
  assert.ok(results.some((r) => r.status === 'NOT_RUN'));
});

test('free preflight: only runs with --profile free', () => {
  const results = runPreflight({ ...ctxFor(), args: {} });
  assert.ok(!results.some((r) => r.id.startsWith('free-')));
});

test('free preflight: a CRLF checkout of render.yaml, firebase.json and the rules still passes', () => {
  const crlf = (path) => real(path).replace(/\r?\n/g, '\r\n');
  const results = free({ 'render.yaml': crlf('render.yaml'), 'firebase.json': crlf('firebase.json'), 'infra/firestore.rules': crlf('infra/firestore.rules') });
  assert.equal(status(results, 'free-render'), 'PASS');
  assert.equal(status(results, 'free-firebase'), 'PASS');
});

const replaceOnce = (from, to) => (text) => { assert.ok(text.includes(from), from); return text.replace(from, to); };
const renderMutations = {
  'a paid plan': replaceOnce('plan: free', 'plan: starter'),
  'a paid plan on the second service only': (text) => { const i = text.lastIndexOf('plan: free'); return `${text.slice(0, i)}plan: standard${text.slice(i + 'plan: free'.length)}`; },
  'a disk': replaceOnce('    healthCheckPath: /health\n    autoDeploy: false\n    envVars:\n      - key: QP_ENV', '    healthCheckPath: /health\n    autoDeploy: false\n    disk:\n      name: d\n      sizeGB: 1\n    envVars:\n      - key: QP_ENV'),
  'a database': (text) => `${text}\ndatabases:\n  - name: db\n    plan: free\n`,
  'a background worker type': replaceOnce('type: web\n    name: queuepilot-worker', 'type: worker\n    name: queuepilot-worker'),
  'another region': replaceOnce('region: frankfurt', 'region: oregon'),
  'autoDeploy on': replaceOnce('autoDeploy: false', 'autoDeploy: true'),
  'a missing health check': replaceOnce('    healthCheckPath: /health\n', ''),
  'TRUST_PROXY_HOPS 0': replaceOnce('value: "3"', 'value: "0"'),
  'TRUST_PROXY_HOPS 2': replaceOnce('value: "3"', 'value: "2"'),
  'TRUST_PROXY_HOPS unquoted': replaceOnce('value: "3"', 'value: 3'),
  'TRUST_PROXY_HOPS missing': replaceOnce('      - key: TRUST_PROXY_HOPS\n        value: "3"\n', ''),
  'QP_CORS_ORIGINS missing': replaceOnce('      - key: QP_CORS_ORIGINS\n        sync: false\n', ''),
  'QP_CORS_ORIGINS with a wildcard': replaceOnce('      - key: QP_CORS_ORIGINS\n        sync: false', '      - key: QP_CORS_ORIGINS\n        value: "*"'),
  'QP_CORS_ORIGINS over http': replaceOnce('      - key: QP_CORS_ORIGINS\n        sync: false', '      - key: QP_CORS_ORIGINS\n        value: http://app.example.test'),
  'QP_CORS_ORIGINS with localhost': replaceOnce('      - key: QP_CORS_ORIGINS\n        sync: false', '      - key: QP_CORS_ORIGINS\n        value: https://localhost'),
  'QP_REGION': replaceOnce('      - key: QP_ENV\n        value: production', '      - key: QP_REGION\n        value: europe-west1\n      - key: QP_ENV\n        value: production'),
  'a Cloud Tasks variable': replaceOnce('      - key: QP_ENV\n        value: production', '      - key: QP_TASKS_QUEUE\n        value: qp-process\n      - key: QP_ENV\n        value: production'),
  'an emulator variable': replaceOnce('      - key: QP_ENV\n        value: production', '      - key: FIRESTORE_EMULATOR_HOST\n        value: 127.0.0.1:8080\n      - key: QP_ENV\n        value: production'),
  'GOOGLE_APPLICATION_CREDENTIALS': replaceOnce('      - key: QP_ENV\n        value: production', '      - key: GOOGLE_APPLICATION_CREDENTIALS\n        value: /etc/secrets/key.json\n      - key: QP_ENV\n        value: production'),
  'PORT set by hand': replaceOnce('      - key: QP_ENV\n        value: production', '      - key: PORT\n        value: "8080"\n      - key: QP_ENV\n        value: production'),
  'an unknown variable': replaceOnce('      - key: QP_ENV\n        value: production', '      - key: QP_NOT_A_SETTING\n        value: "1"\n      - key: QP_ENV\n        value: production'),
  'the cloud queue adapter': replaceOnce('      - key: QP_QUEUE_ADAPTER\n        value: qstash', '      - key: QP_QUEUE_ADAPTER\n        value: cloud'),
  'the oidc auth mode': replaceOnce('      - key: QP_WORKER_AUTH_MODE\n        value: qstash', '      - key: QP_WORKER_AUTH_MODE\n        value: oidc'),
  'a non-production environment': replaceOnce('      - key: QP_ENV\n        value: production', '      - key: QP_ENV\n        value: development'),
  'an http worker URL': replaceOnce('      - key: QP_WORKER_URL\n        sync: false', '      - key: QP_WORKER_URL\n        value: http://queuepilot-worker.example.test'),
  'a worker URL with a path': replaceOnce('      - key: QP_WORKER_URL\n        sync: false', '      - key: QP_WORKER_URL\n        value: https://queuepilot-worker.example.test/internal'),
  'a QStash timeout without a unit': replaceOnce('value: 90s', 'value: "90"'),
  'a demo project': replaceOnce('      - key: GCLOUD_PROJECT\n        sync: false', '      - key: GCLOUD_PROJECT\n        value: demo-queuepilot'),
  'a flow-style env list': replaceOnce('    envVars:\n      - key: QP_ENV', '    envVars: [{key: QP_ENV, value: production}]\n    x:\n      - key: QP_ENV'),
};
for (const [label, mutate] of Object.entries(renderMutations)) {
  test(`free preflight: render.yaml with ${label} FAILS`, () => {
    const results = free(render(mutate));
    assert.ok(['free-render', 'free-render-syntax'].some((id) => status(results, id) === 'FAIL'), JSON.stringify(results.filter((r) => r.id.startsWith('free-render'))));
    assert.equal(summarize(results).exitCode, 1);
  });
}

test('free preflight: every declared secret must be sync:false with no value, and a violation never echoes the value', () => {
  const fakeKey = '-----BEGIN PRIVATE KEY----- FAKE-key-body-5a1c9e -----END PRIVATE KEY-----';
  const fakeRedis = 'rediss://default:FAKE-redis-pass-1d84e7@redis.invalid:6380';
  for (const name of SECRET_ENV) {
    const withValue = free(render(replaceOnce(`      - key: ${name}\n        sync: false`, `      - key: ${name}\n        value: "SUPER-visible-value-8c2f"`)));
    assert.equal(status(withValue, 'free-render'), 'FAIL', `${name} with a value`);
    assert.ok(!JSON.stringify(withValue).includes('SUPER-visible-value-8c2f'), `${name}: the value must not be echoed`);
    const syncTrue = free(render(replaceOnce(`      - key: ${name}\n        sync: false`, `      - key: ${name}\n        sync: true`)));
    assert.equal(status(syncTrue, 'free-render'), 'FAIL', `${name} with sync true`);
    const bare = free(render(replaceOnce(`      - key: ${name}\n        sync: false`, `      - key: ${name}`)));
    assert.equal(status(bare, 'free-render'), 'FAIL', `${name} without sync`);
  }
  for (const [name, secret, probe] of [['QP_FIREBASE_SERVICE_ACCOUNT_JSON', fakeKey, 'FAKE-key-body-5a1c9e'], ['REDIS_URL', fakeRedis, 'FAKE-redis-pass-1d84e7']]) {
    const results = free(render(replaceOnce(`      - key: ${name}\n        sync: false`, `      - key: ${name}\n        value: "${secret}"`)));
    assert.equal(status(results, 'free-render'), 'FAIL');
    assert.ok(!JSON.stringify(results).includes(probe), `${name}: the secret must not be echoed`);
  }
  // A secret-looking name that is not on the list is held to the same rule.
  const extra = free(render(replaceOnce('      - key: QP_ENV\n        value: production', '      - key: QP_ADMIN_TOKEN\n        value: abc\n      - key: QP_ENV\n        value: production')));
  assert.equal(status(extra, 'free-render'), 'FAIL');
});

test('free preflight: the real render.yaml declares every secret with sync:false and no value', () => {
  const { services } = parseBlueprint(real('render.yaml'));
  for (const service of services) {
    for (const name of SECRET_ENV) {
      const entry = service.envVars.find((e) => e.key === name);
      assert.deepEqual(entry, { key: name, sync: false }, `${service.name}.${name}`);
    }
    assert.ok(service.envVars.every((e) => (e.sync === false) !== Object.hasOwn(e, 'value')), `${service.name}: value xor sync:false`);
  }
});

test('free preflight: the two services must agree on the worker URL when it is filled in', () => {
  const text = real('render.yaml');
  const i = text.indexOf('      - key: QP_WORKER_URL\n        sync: false');
  const j = text.indexOf('      - key: QP_WORKER_URL\n        sync: false', i + 1);
  const url = (host) => `      - key: QP_WORKER_URL\n        value: https://${host}.example.test`;
  const filled = (a, b) => `${text.slice(0, i)}${url(a)}${text.slice(i + '      - key: QP_WORKER_URL\n        sync: false'.length, j)}${url(b)}${text.slice(j + '      - key: QP_WORKER_URL\n        sync: false'.length)}`;
  assert.equal(status(free({ 'render.yaml': filled('qp-worker', 'qp-worker') }), 'free-render'), 'PASS');
  assert.equal(status(free({ 'render.yaml': filled('qp-worker', 'qp-other') }), 'free-render'), 'FAIL');
});

const firebaseMutations = {
  'Functions': (c) => ({ ...c, functions: { source: 'functions' } }),
  'Storage': (c) => ({ ...c, storage: { rules: 'storage.rules' } }),
  'a Cloud Run rewrite': (c) => ({ ...c, hosting: { ...c.hosting, rewrites: [{ source: '/api/**', run: { serviceId: 'qp-api', region: 'europe-west1' } }, ...c.hosting.rewrites] } }),
  'a function rewrite': (c) => ({ ...c, hosting: { ...c.hosting, rewrites: [{ source: '/api/**', function: 'api' }, ...c.hosting.rewrites] } }),
  'no SPA rewrite': (c) => ({ ...c, hosting: { ...c.hosting, rewrites: [] } }),
  'another public directory': (c) => ({ ...c, hosting: { ...c.hosting, public: 'dist' } }),
  'no security headers': (c) => ({ ...c, hosting: { ...c.hosting, headers: [] } }),
  'no Firestore rules file': (c) => ({ ...c, firestore: { indexes: c.firestore.indexes } }),
  'a missing rules file': (c) => ({ ...c, firestore: { ...c.firestore, rules: 'infra/nope.rules' } }),
  'an emulator on all interfaces': (c) => ({ ...c, emulators: { ...c.emulators, firestore: { host: '0.0.0.0', port: 8080 } } }),
};
for (const [label, mutate] of Object.entries(firebaseMutations)) {
  test(`free preflight: firebase.json with ${label} FAILS`, () => {
    assert.equal(status(free(firebase(mutate)), 'free-firebase'), 'FAIL');
  });
}

test('free preflight: weakened Firestore rules FAIL, the deny-all rules pass', () => {
  assert.equal(status(free({ 'infra/firestore.rules': 'service cloud.firestore { match /{d=**} { allow read, write: if true; } }' }), 'free-firebase'), 'FAIL');
  assert.equal(status(free({ 'infra/firestore.rules': 'service cloud.firestore { match /{d=**} { allow read: if request.auth != null; } }' }), 'free-firebase'), 'FAIL');
  assert.equal(status(free(), 'free-firebase'), 'PASS');
});

test('free preflight: .firebaserc must name a project; a demo project fails, a real-looking one passes', () => {
  const rc = (id) => ({ '.firebaserc': JSON.stringify({ projects: { default: id } }) });
  assert.equal(status(free(rc('demo-queuepilot')), 'free-firebaserc'), 'FAIL');
  assert.equal(status(free(rc('qp-example-project')), 'free-firebaserc'), 'PASS');
  assert.equal(status(free({ '.firebaserc': '{}' }), 'free-firebaserc'), 'FAIL');
});

test('free preflight: apps that do not listen on 0.0.0.0 at config.PORT FAIL', () => {
  const index = real('apps/api/src/index.ts');
  assert.equal(status(free({ 'apps/api/src/index.ts': index.replace("host: '0.0.0.0'", "host: '127.0.0.1'") }), 'free-port-wiring'), 'FAIL');
  assert.equal(status(free({ 'apps/api/src/index.ts': index.replace('config.PORT', '8080') }), 'free-port-wiring'), 'FAIL');
});

test('free preflight: warns when the adapter is qstash and TRUST_PROXY_HOPS is 0 or unset; the warning does not fail the run', () => {
  for (const hops of ['0', undefined, ' ']) {
    const results = free({}, { QP_QUEUE_ADAPTER: 'qstash', ...(hops === undefined ? {} : { TRUST_PROXY_HOPS: hops }) });
    assert.equal(status(results, 'free-trust-proxy-hops'), 'WARN', String(hops));
    assert.equal(summarize(results).exitCode, 0);
  }
  assert.equal(status(free({}, { QP_QUEUE_ADAPTER: 'qstash', TRUST_PROXY_HOPS: '3' }), 'free-trust-proxy-hops'), undefined);
  assert.equal(status(free({}, { QP_QUEUE_ADAPTER: 'cloud' }), 'free-trust-proxy-hops'), undefined);
  assert.equal(status(free({}, {}), 'free-trust-proxy-hops'), undefined);
});

test('preflight CLI: --profile free prints the free checks and rejects other profiles and --run', () => {
  const lines = [];
  const io = { out: (m) => lines.push(m), err: (m) => lines.push(m) };
  const code = preflightMain(['--profile', 'free'], io, { QP_QUEUE_ADAPTER: 'qstash', TRUST_PROXY_HOPS: '0', REDIS_URL: 'rediss://default:SuperSecretPassw0rd@x.invalid:6379' });
  assert.equal(code, 0);
  const text = lines.join('\n');
  assert.match(text, /\[WARN\] free-trust-proxy-hops/);
  assert.match(text, /\[PASS\] free-render:/);
  assert.ok(!text.includes('SuperSecretPassw0rd'));
  refuses(() => preflightMain(['--profile', 'gcp'], io, {}), EXIT.USAGE);
  refuses(() => preflightMain(['--profile', 'free', '--run'], io, {}), EXIT.USAGE);
});

// ---- seed-demo: limit parameter and free profile ----
const FS_ONLY = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
const seed = (list) => parseSeedArgs(['--project', 'demo-queuepilot', ...list], FS_ONLY);
const seedIo = () => { const lines = []; return { lines, out: (m) => lines.push(m), err: (m) => lines.push(m) }; };

test('seed-demo: the default sandbox is unchanged (2000/day) and the limit is a parameter', () => {
  assert.equal(DEFAULT_TENANT_DAILY_LIMIT, 2000);
  assert.deepEqual(sandboxTenant(false), sandboxTenant(false, 2000));
  assert.equal(seed(['--open-signup', 'false']).tenantDailyLimit, 2000);
  assert.equal(seed(['--open-signup', 'false', '--tenant-daily-limit', '120']).tenantDailyLimit, 120);
  assert.equal(sandboxTenant(false, 120).limits.submitPerDayTenant, 120);
  assert.equal(sandboxTenant(false, 120).limits.submitPerDayUser, 30);
});

test('seed-demo: the free profile defaults to 300/day and a closed sandbox, and sign-up can still be opened on purpose', () => {
  assert.equal(FREE_TENANT_DAILY_LIMIT, 300);
  assert.deepEqual([seed(['--profile', 'free']).openSignup, seed(['--profile', 'free']).tenantDailyLimit], [false, 300]);
  assert.equal(seed(['--profile', 'free', '--open-signup', 'true']).openSignup, true);
  assert.equal(seed(['--profile', 'free', '--tenant-daily-limit', '50']).tenantDailyLimit, 50);
  refuses(() => seed([]), EXIT.USAGE); // outside the free profile the sign-up choice stays mandatory
  refuses(() => seed(['--profile', 'gcp']), EXIT.USAGE);
});

test('seed-demo: limit validation', () => {
  for (const bad of ['0', '-1', '2001', '1e3', '300.5', 'abc', '', ' 300', '0300']) {
    refuses(() => seed(['--open-signup', 'false', '--tenant-daily-limit', bad]), EXIT.USAGE);
  }
  for (const good of ['1', '300', '2000']) assert.equal(seed(['--open-signup', 'false', '--tenant-daily-limit', good]).tenantDailyLimit, Number(good));
  refuses(() => seed(['--profile', 'other']), EXIT.USAGE);
  refuses(() => seed(['--profile', 'free', '--tenant-daily-limit', '1', '--tenant-daily-limit', '2']), EXIT.USAGE);
});

test('seed-demo: the dry run stays the default, shows the 300/day tenant and reads and writes nothing', async () => {
  const touched = [];
  const store = { get: async () => touched.push('get'), create: async () => touched.push('create'), update: async () => touched.push('update') };
  const out = seedIo();
  const code = await seedDemo(seed(['--profile', 'free']), { io: out, firestore: () => store, cloudClient: () => { throw new Error('no cloud'); } });
  assert.equal(code, EXIT.OK);
  assert.deepEqual(touched, []);
  assert.match(out.lines.join('\n'), /DRY RUN[\s\S]*"openSignup":false[\s\S]*"submitPerDayTenant":300/);
});

test('seed-demo: apply writes the limit, a rerun is unchanged, and a different stored limit is reported as DRIFT', async () => {
  const docs = new Map();
  const store = {
    create: async (collection, id, data) => { const path = `${collection}/${id}`; if (docs.has(path)) return false; docs.set(path, data); return true; },
    get: async (path) => (docs.has(path) ? { data: docs.get(path), updateTime: 't' } : null),
  };
  const args = ['--profile', 'free', '--apply', '--approve-project', 'demo-queuepilot'];
  const run = async (list) => { const out = seedIo(); return { code: await seedDemo(seed(list), { io: out, firestore: () => store, cloudClient: () => { throw new Error('no cloud'); } }), out }; };
  assert.equal((await run(args)).code, EXIT.OK);
  assert.equal(docs.get('tenants/sandbox').limits.submitPerDayTenant, 300);
  assert.match((await run(args)).out.lines.join('\n'), /unchanged/);
  const drift = await run([...args, '--tenant-daily-limit', '100']);
  assert.equal(drift.code, EXIT.STATE);
  assert.match(drift.out.lines.join('\n'), /DRIFT tenants\/sandbox: fields differ from the seed: limits/);
  assert.equal(docs.get('tenants/sandbox').limits.submitPerDayTenant, 300); // never overwritten
});
