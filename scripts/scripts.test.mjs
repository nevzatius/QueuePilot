import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CloudError } from '../infra/cloud.mjs';
import { EXIT, FirestoreRest, ScriptError, resolveTarget, runCli, verifyCloudProject } from './lib/ops.mjs';
import { planDigest } from './lib/cloud-ops.mjs';
import { runPreflight, summarize } from './lib/preflight.mjs';
import { decideGrant, grantRole, parseGrantArgs } from './grant-role.mjs';
import { parseSeedArgs, sandboxTenant, seedDemo } from './seed-demo.mjs';
import { parseDeployArgs, runDeploy } from './deploy.mjs';
import { parseShutdownArgs, runShutdown, shutdownTargets } from './shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const EMU = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
const io = () => { const lines = []; return { lines, out: (m) => lines.push(m), err: (m) => lines.push(m) }; };
const refuses = (fn, exitCode) => assert.throws(fn, (error) => error instanceof ScriptError && error.exitCode === exitCode, `expected exit ${exitCode}`);
const rejects = (fn, exitCode) => assert.rejects(async () => fn(), (error) => error instanceof ScriptError && error.exitCode === exitCode, `expected exit ${exitCode}`);

/** In-memory Firestore double with the same contract as FirestoreRest; records every write. */
class FakeStore {
  constructor(docs = {}) { this.docs = new Map(Object.entries(docs).map(([k, v]) => [k, { data: v, updateTime: 't1' }])); this.writes = []; this.reads = []; }
  async get(path) { this.reads.push(path); return this.docs.get(path) ?? null; }
  async create(collection, id, data) {
    const path = `${collection}/${id}`;
    if (this.docs.has(path)) return false;
    this.writes.push(['create', path, data]); this.docs.set(path, { data, updateTime: 't1' }); return true;
  }
  async update(path, data, updateTime) {
    assert.equal(updateTime, this.docs.get(path).updateTime, 'update must carry the read precondition');
    this.writes.push(['update', path, data]); this.docs.get(path).data = { ...this.docs.get(path).data, ...data };
  }
}
const noCloud = () => { throw new Error('cloud/credentials must not be touched'); };
const deps = (store, extra = {}) => ({ io: io(), now: () => 1_700_000_000_000, cloudClient: noCloud, firestore: () => store, ...extra });
const active = { name: 'T', status: 'active', openSignup: true, quotaMode: 'enforced', schemaVersion: 1 };
const argsFor = (list) => parseGrantArgs(list, EMU);
const apply = ['--project', 'demo-queuepilot', '--tenant', 'sandbox', '--uid', 'user-1', '--apply', '--approve-project', 'demo-queuepilot'];

test('resolveTarget: project, approval and environment guards', () => {
  refuses(() => resolveTarget({ env: {} }), EXIT.USAGE);
  refuses(() => resolveTarget({ project: 'BAD_ID', env: {} }), EXIT.USAGE);
  refuses(() => resolveTarget({ project: 'qp-demo-12345', apply: true, env: {} }), EXIT.REFUSED); // no approval
  refuses(() => resolveTarget({ project: 'qp-demo-12345', approveProject: 'other-project-1', apply: true, env: {} }), EXIT.REFUSED);
  refuses(() => resolveTarget({ project: 'qp-demo-12345', approveProject: 'other-project-1', env: {} }), EXIT.REFUSED); // mismatch even in dry run
  refuses(() => resolveTarget({ project: 'demo-queuepilot', env: {} }), EXIT.REFUSED); // demo-* only with the emulator
  refuses(() => resolveTarget({ project: 'queuepilot-prod', env: {} }), EXIT.REFUSED);
  refuses(() => resolveTarget({ project: 'qp-demo-12345', env: EMU }), EXIT.REFUSED); // emulator host with a real-looking project
  refuses(() => resolveTarget({ project: 'demo-queuepilot', env: { FIRESTORE_EMULATOR_HOST: 'firestore.example.com:8080' } }), EXIT.REFUSED);
  assert.equal(resolveTarget({ project: 'qp-demo-12345', approveProject: 'qp-demo-12345', apply: true, env: {} }).mode, 'cloud');
  assert.equal(resolveTarget({ project: 'demo-queuepilot', env: EMU }).mode, 'emulator');
});

test('grant-role: argument validation', () => {
  const base = ['--project', 'demo-queuepilot', '--tenant', 'sandbox', '--uid', 'user-1'];
  assert.equal(argsFor(base).apply, false);
  refuses(() => argsFor(['--project', 'demo-queuepilot', '--uid', 'user-1']), EXIT.USAGE); // no tenant
  refuses(() => argsFor(['--project', 'demo-queuepilot', '--tenant', 'sandbox']), EXIT.USAGE); // no uid
  refuses(() => argsFor(['--project', 'demo-queuepilot', '--tenant', '*', '--uid', 'user-1']), EXIT.USAGE); // no wildcard tenants
  refuses(() => argsFor(['--project', 'demo-queuepilot', '--tenant', 'sandbox', '--uid', '*']), EXIT.USAGE);
  refuses(() => argsFor(['--project', 'demo-queuepilot', '--tenant', 'sandbox', '--uid', 'a/b']), EXIT.USAGE); // path injection
  refuses(() => argsFor([...base, '--role', 'member']), EXIT.USAGE);
  refuses(() => argsFor([...base, '--all-tenants']), EXIT.USAGE); // unknown flag
  refuses(() => argsFor([...base, 'stray']), EXIT.USAGE); // positional
  refuses(() => argsFor([...base, '--uid', 'user-2']), EXIT.USAGE); // repeated value
  refuses(() => argsFor([...base, '--apply']), EXIT.REFUSED); // no approval
  refuses(() => argsFor([...base, '--apply', '--approve-project', 'demo-other']), EXIT.REFUSED); // wrong project
});

test('grant-role: dry run never reads or writes and never asks for credentials', async () => {
  const store = new FakeStore();
  const d = deps(store, { firestore: noCloud });
  assert.equal(await grantRole(argsFor(apply.slice(0, 6)), d), EXIT.OK);
  assert.deepEqual(store.reads, []); assert.deepEqual(store.writes, []);
  assert.match(d.io.lines.join('\n'), /DRY RUN.*project=demo-queuepilot.*tenant=sandbox.*uid=user-1/);
});

test('grant-role: apply creates an operator-created admin in exactly one tenant', async () => {
  const store = new FakeStore({ 'tenants/sandbox': active });
  assert.equal(await grantRole(argsFor(apply), deps(store)), EXIT.OK);
  assert.equal(store.writes.length, 1);
  const [kind, path, data] = store.writes[0];
  assert.deepEqual([kind, path], ['create', 'memberships/user-1']);
  assert.deepEqual({ ...data, updatedAt: undefined }, { tenantId: 'sandbox', role: 'admin', status: 'active', createdBy: 'operator', updatedAt: undefined, schemaVersion: 1 });
  assert.equal(await grantRole(argsFor(apply), deps(store)), EXIT.OK); // idempotent
  assert.equal(store.writes.length, 1);
});

test('grant-role: state refusals (missing/suspended tenant, other tenant, suspended member) write nothing', async () => {
  const cases = [
    {}, // tenant missing
    { 'tenants/sandbox': { ...active, status: 'suspended' } },
    { 'tenants/sandbox': active, 'memberships/user-1': { tenantId: 'other', role: 'member', status: 'active', schemaVersion: 1 } },
    { 'tenants/sandbox': active, 'memberships/user-1': { tenantId: 'sandbox', role: 'member', status: 'suspended', schemaVersion: 1 } },
  ];
  for (const docs of cases) {
    const store = new FakeStore(docs);
    await rejects(() => grantRole(argsFor(apply), deps(store)), EXIT.STATE);
    assert.deepEqual(store.writes, []);
  }
});

test('grant-role: promotes an active member with the read precondition and only touches role/updatedAt', async () => {
  const store = new FakeStore({ 'tenants/sandbox': active, 'memberships/user-1': { tenantId: 'sandbox', role: 'member', status: 'active', createdBy: 'bootstrap', schemaVersion: 1 } });
  await grantRole(argsFor(apply), deps(store));
  assert.equal(store.writes[0][0], 'update');
  assert.deepEqual(Object.keys(store.writes[0][2]).sort(), ['role', 'updatedAt']);
  assert.equal(decideGrant({ data: { tenantId: 'sandbox', role: 'admin', status: 'active' } }, 'sandbox').action, 'noop');
});

test('cloud mode: a project without the demo label or with another identity is refused before any Firestore access', async () => {
  const ok = { projectId: 'qp-demo-12345', lifecycleState: 'ACTIVE', labels: { 'queuepilot-environment': 'demo' } };
  const cloudArgs = ['--project', 'qp-demo-12345', '--tenant', 'sandbox', '--uid', 'user-1', '--apply', '--approve-project', 'qp-demo-12345'];
  for (const info of [{ ...ok, labels: {} }, { ...ok, lifecycleState: 'DELETE_REQUESTED' }, { ...ok, projectId: 'someone-else-1' }]) {
    const store = new FakeStore({ 'tenants/sandbox': active });
    await rejects(() => grantRole(parseGrantArgs(cloudArgs, {}), deps(store, { cloudClient: () => async () => info })), EXIT.REFUSED);
    assert.deepEqual(store.reads, []); assert.deepEqual(store.writes, []);
  }
  const mismatch = new FakeStore({ 'tenants/sandbox': active });
  await rejects(() => grantRole(parseGrantArgs([...cloudArgs, '--project-number', '999999999999'], {}), deps(mismatch, { cloudClient: () => async () => ({ ...ok, projectNumber: '123456789012' }) })), EXIT.REFUSED);
  assert.deepEqual(mismatch.reads, []);
  refuses(() => parseGrantArgs([...cloudArgs, '--project-number', 'abc'], {}), EXIT.USAGE);
  const store = new FakeStore({ 'tenants/sandbox': active });
  assert.equal(await grantRole(parseGrantArgs(cloudArgs, {}), deps(store, { cloudClient: () => async () => ok })), EXIT.OK);
  assert.equal(store.writes.length, 1);
  await rejects(() => verifyCloudProject({ mode: 'cloud', project: 'x' }, { client: async () => { throw new Error('boom'); } }), EXIT.IO);
});

test('FirestoreRest: create-only, precondition update, and errors never echo response bodies', async () => {
  const calls = [];
  const respond = (status, body = {}) => async (url, init) => { calls.push({ url, init }); return { status, json: async () => body }; };
  const target = { mode: 'emulator', project: 'demo-queuepilot', emulatorHost: '127.0.0.1:8080' };
  const client = (status, body) => new FirestoreRest({ target, token: noCloud, fetchImpl: respond(status, body) });
  assert.equal(await client(409).create('memberships', 'u1', { role: 'admin' }), false);
  assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:8080\/v1\/projects\/demo-queuepilot\/databases\/\(default\)\/documents\/memberships\?documentId=u1$/);
  assert.equal(calls[0].init.method, 'POST');
  await client(200).update('memberships/u1', { role: 'admin' }, '2026-01-01T00:00:00Z');
  assert.match(calls[1].url, /\/documents:commit$/);
  assert.deepEqual(JSON.parse(calls[1].init.body).writes[0].currentDocument, { updateTime: '2026-01-01T00:00:00Z' });
  assert.deepEqual(JSON.parse(calls[1].init.body).writes[0].updateMask, { fieldPaths: ['role'] });
  await rejects(() => client(400, { error: { status: 'FAILED_PRECONDITION' } }).update('memberships/u1', { role: 'admin' }, 'x'), EXIT.STATE);
  await rejects(() => client(400, { error: { status: 'INVALID_ARGUMENT' } }).update('memberships/u1', { role: 'admin' }, 'x'), EXIT.IO);
  await assert.rejects(client(403, { error: { status: 'PERMISSION_DENIED', message: 'secret-token-abc' } }).get('memberships/u1'),
    (error) => error.exitCode === EXIT.IO && !/secret-token-abc/.test(error.message) && /PERMISSION_DENIED/.test(error.message));
  assert.equal(await client(404).get('memberships/u1'), null);
});

test('runCli maps errors to exit codes without leaking unexpected details', async () => {
  const out = io();
  assert.equal(await runCli(async () => { throw new ScriptError(EXIT.REFUSED, 'nope'); }, [], out), EXIT.REFUSED);
  assert.equal(await runCli(async () => { throw new Error('token=abc123'); }, [], out), EXIT.IO);
  assert.ok(!out.lines.join('\n').includes('abc123'));
});

test('seed-demo: explicit signup choice, dry run, idempotency, drift and member-only memberships', async () => {
  const seed = (list) => parseSeedArgs(list, EMU);
  const base = ['--project', 'demo-queuepilot', '--open-signup', 'false'];
  refuses(() => seed(['--project', 'demo-queuepilot']), EXIT.USAGE); // signup must be a conscious choice
  refuses(() => seed([...base.slice(0, 2), '--open-signup', 'maybe']), EXIT.USAGE);
  refuses(() => seed([...base, '--apply']), EXIT.REFUSED);
  refuses(() => seed([...base, '--apply', '--approve-project', 'demo-other']), EXIT.REFUSED); // wrong project
  refuses(() => seed([...base, '--member-uid', 'a b']), EXIT.USAGE);

  const dry = new FakeStore();
  assert.equal(await seedDemo(seed(base), deps(dry, { firestore: noCloud })), EXIT.OK);
  assert.deepEqual([dry.reads, dry.writes], [[], []]);

  const store = new FakeStore();
  const applyArgs = [...base, '--apply', '--approve-project', 'demo-queuepilot', '--member-uid', 'user-1'];
  await seedDemo(seed(applyArgs), deps(store));
  assert.deepEqual(store.writes.map((w) => w[1]), ['tenants/sandbox', 'memberships/user-1']);
  assert.deepEqual(store.writes[0][2], sandboxTenant(false));
  assert.equal(store.writes[1][2].role, 'member');
  assert.ok(!store.writes.some((w) => w[2].role === 'admin'));
  await seedDemo(seed(applyArgs), deps(store)); // rerun: no further writes
  assert.equal(store.writes.length, 2);

  store.docs.get('tenants/sandbox').data = { ...sandboxTenant(true) }; // drift is reported, not overwritten
  await rejects(() => seedDemo(seed(applyArgs), deps(store)), EXIT.STATE);
  const other = new FakeStore({ 'tenants/sandbox': sandboxTenant(false), 'memberships/user-1': { tenantId: 'other', role: 'admin', status: 'active', createdBy: 'operator', schemaVersion: 1 } });
  await rejects(() => seedDemo(seed(applyArgs), deps(other)), EXIT.STATE);
  assert.deepEqual(other.writes, []);
});

// ---- deploy / shutdown wrappers ----
const digest64 = 'a'.repeat(64);
const cfg = { projectId: 'qp-demo-12345', projectNumber: '123456789012', environment: 'demo', region: 'europe-west1',
  apiImage: `europe-west1-docker.pkg.dev/qp-demo-12345/queuepilot/api@sha256:${digest64}`,
  workerImage: `europe-west1-docker.pkg.dev/qp-demo-12345/queuepilot/worker@sha256:${digest64}`, redisSecretVersion: '1' };
const cfgText = JSON.stringify(cfg);
const deployDeps = (text = cfgText) => { const applied = []; return { applied, io: io(), readFile: () => text, runApply: (args) => { applied.push(args); return 0; } }; };
const dep = (list) => parseDeployArgs(['--config', 'c.json', '--project', 'qp-demo-12345', '--region', 'europe-west1', ...list]);
const approvals = (stage, extra = []) => ['--stage', stage, '--apply', '--approve-project', 'qp-demo-12345', '--approve-region', 'europe-west1',
  '--approve-plan', planDigest(cfg, stage), ...extra];

test('deploy: dry run prints a plan, calls nothing and never delegates', () => {
  const d = deployDeps();
  assert.equal(runDeploy(dep(['--stage', 'queue']), d), EXIT.OK);
  assert.deepEqual(d.applied, []);
  const text = d.io.lines.join('\n');
  assert.match(text, /qp-process.*PAUSES it|PAUSES it/);
  assert.match(text, /DRY RUN/);
  assert.match(text, /Plan digest: [a-f0-9]{12}/);
});

test('deploy: validation and approval refusals', () => {
  refuses(() => parseDeployArgs(['--project', 'p']), EXIT.USAGE); // no config
  refuses(() => parseDeployArgs(['--config', 'c.json']), EXIT.USAGE); // no stage
  refuses(() => runDeploy(dep(['--stage', 'all']), deployDeps()), EXIT.USAGE);
  refuses(() => runDeploy(dep(['--stage', 'nope']), deployDeps()), EXIT.USAGE);
  refuses(() => runDeploy(parseDeployArgs(['--config', 'c', '--project', 'qp-demo-12345', '--stage', 'queue']), deployDeps()), EXIT.USAGE); // no region
  refuses(() => runDeploy(parseDeployArgs(['--config', 'c', '--project', 'qp-demo-12345', '--region', 'us-central1', '--stage', 'queue']), deployDeps()), EXIT.REFUSED);
  refuses(() => runDeploy(parseDeployArgs(['--config', 'c', '--project', 'other-project-1', '--region', 'europe-west1', '--stage', 'queue']), deployDeps()), EXIT.REFUSED);
  refuses(() => runDeploy(dep(['--stage', 'queue']), deployDeps('{not json')), EXIT.USAGE);
  refuses(() => runDeploy(dep(['--stage', 'queue']), deployDeps(JSON.stringify({ ...cfg, secretKey: 'x' }))), EXIT.USAGE); // unknown/credential keys
  refuses(() => runDeploy(dep(['--stage', 'queue']), deployDeps(JSON.stringify({ ...cfg, region: 'us-central1' }))), EXIT.USAGE);
  refuses(() => runDeploy(dep(['--stage', 'queue', '--apply']), deployDeps()), EXIT.REFUSED); // no approvals
  refuses(() => runDeploy(dep(['--stage', 'queue', '--apply', '--approve-project', 'qp-demo-12345']), deployDeps()), EXIT.REFUSED); // no region approval
  refuses(() => runDeploy(dep(['--stage', 'queue', '--apply', '--approve-project', 'qp-demo-12345', '--approve-region', 'europe-west1']), deployDeps()), EXIT.REFUSED); // no plan digest
  refuses(() => runDeploy(dep(['--stage', 'queue', '--apply', '--approve-project', 'qp-demo-12345', '--approve-region', 'europe-west1', '--approve-plan', '000000000000']), deployDeps()), EXIT.REFUSED);
  const placeholder = JSON.stringify({ ...cfg, projectId: 'replace-with-demo-project' });
  refuses(() => runDeploy(parseDeployArgs(['--config', 'c', '--project', 'replace-with-demo-project', '--region', 'europe-west1', ...approvals('queue')]), deployDeps(placeholder)), EXIT.USAGE);
});

test('deploy: stage-specific approvals, then delegation to infra/apply.mjs with exact arguments', () => {
  refuses(() => runDeploy(dep(approvals('data')), deployDeps()), EXIT.REFUSED); // irreversible location not approved
  refuses(() => runDeploy(dep(approvals('iam')), deployDeps()), EXIT.REFUSED); // public API not approved
  refuses(() => runDeploy(dep(approvals('scheduler', ['--approve-b4-worker-image', cfg.apiImage])), deployDeps()), EXIT.REFUSED);
  for (const [stage, extra] of [['data', ['--approve-firestore-location', 'europe-west1']], ['iam', ['--approve-public-api']], ['queue', []], ['bootstrap', []]]) {
    const d = deployDeps();
    assert.equal(runDeploy(dep(approvals(stage, extra)), d), 0, stage);
    assert.equal(d.applied.length, 1);
    const args = d.applied[0];
    assert.equal(args[0], 'infra/apply.mjs');
    assert.ok(args.includes('--apply') && args.includes('--approve-project=qp-demo-12345') && args.includes(stage));
    assert.ok(!args.includes('all') && !args.some((a) => /resume/i.test(a)));
  }
  const d = deployDeps();
  runDeploy(dep(approvals('scheduler', ['--approve-b4-worker-image', cfg.workerImage])), d);
  assert.ok(d.applied[0].includes(`--approve-b4-worker-image=${cfg.workerImage}`));
  const withoutImage = deployDeps();
  runDeploy(dep(approvals('scheduler')), withoutImage);
  assert.ok(!withoutImage.applied[0].some((a) => a.startsWith('--approve-b4-worker-image')), 'scheduler stays DEFERRED without the image approval');
});

test('deploy: the plan digest changes with the configuration', () => {
  assert.notEqual(planDigest(cfg, 'deploy'), planDigest({ ...cfg, workerImage: cfg.workerImage.replace('a'.repeat(64), 'b'.repeat(64)) }, 'deploy'));
});

/** Fake Google API: GET returns state, POST :pause flips it. Records every call. */
function fakeCloud({ queue = 'RUNNING', job = 'ENABLED', labels = { 'queuepilot-environment': 'demo' }, number = cfg.projectNumber, stuck = false } = {}) {
  const calls = [];
  const state = { queue, job };
  const loc = `projects/${cfg.projectId}/locations/${cfg.region}`;
  const client = async (host, path, method = 'GET') => {
    calls.push(`${method} ${host} ${path}`);
    if (host === 'cloudresourcemanager') return { projectId: cfg.projectId, projectNumber: number, lifecycleState: 'ACTIVE', labels };
    const key = host === 'cloudtasks' ? 'queue' : 'job';
    const resource = path.replace(/:pause$/, '');
    assert.ok(resource === `${host === 'cloudtasks' ? 'v2' : 'v1'}/${loc}/${host === 'cloudtasks' ? 'queues/qp-process' : 'jobs/qp-reconcile'}`, `unexpected resource ${path}`);
    if (state[key] === null) throw new CloudError(404, 'NOT_FOUND');
    if (method === 'POST') { assert.ok(path.endsWith(':pause')); if (!stuck) state[key] = 'PAUSED'; return {}; }
    return { state: state[key] };
  };
  return { calls, state, client };
}
const sd = (cloud, text = cfgText) => ({ io: io(), readFile: () => text, client: () => cloud.client });
const shut = (list) => parseShutdownArgs(['--config', 'c.json', '--project', 'qp-demo-12345', '--region', 'europe-west1', ...list]);
const shutApply = ['--apply', '--approve-project', 'qp-demo-12345', '--approve-region', 'europe-west1'];

test('shutdown: dry run lists targets and limits, makes no cloud call', async () => {
  const cloud = fakeCloud();
  const d = sd(cloud);
  d.client = noCloud;
  assert.equal(await runShutdown(shut([]), d), EXIT.OK);
  const text = d.io.lines.join('\n');
  assert.match(text, /pause Scheduler job qp-reconcile/);
  assert.match(text, /pause Cloud Tasks queue qp-process/);
  assert.match(text, /NOT deleted/);
  assert.match(text, /Scale-to-zero is not zero cost/);
  assert.deepEqual(cloud.calls, []);
});

test('shutdown: approval and scope refusals happen before any cloud call', async () => {
  const cloud = fakeCloud();
  await rejects(() => runShutdown(shut(['--apply']), sd(cloud)), EXIT.REFUSED);
  await rejects(() => runShutdown(shut(['--apply', '--approve-project', 'qp-demo-12345']), sd(cloud)), EXIT.REFUSED);
  await rejects(() => runShutdown(shut(['--apply', '--approve-project', 'wrong-project-1', '--approve-region', 'europe-west1']), sd(cloud)), EXIT.REFUSED);
  await rejects(() => runShutdown(parseShutdownArgs(['--config', 'c', '--project', 'qp-demo-12345', '--region', 'asia-east1', ...shutApply]), sd(cloud)), EXIT.REFUSED);
  refuses(() => parseShutdownArgs(['--project', 'p']), EXIT.USAGE);
  assert.deepEqual(cloud.calls, []);
});

test('shutdown: pauses scheduler then queue, confirms PAUSED, only GET and :pause POST are ever issued', async () => {
  const cloud = fakeCloud();
  assert.equal(await runShutdown(shut(shutApply), sd(cloud)), EXIT.OK);
  assert.deepEqual(cloud.state, { queue: 'PAUSED', job: 'PAUSED' });
  const posts = cloud.calls.filter((c) => c.startsWith('POST'));
  assert.equal(posts.length, 2);
  assert.ok(posts[0].includes('cloudscheduler') && posts[1].includes('cloudtasks'), 'producer is paused first');
  assert.ok(cloud.calls.every((c) => /^(GET|POST)/.test(c) && !/DELETE|PATCH|resume/i.test(c)));
  const again = fakeCloud({ queue: 'PAUSED', job: 'PAUSED' });
  await runShutdown(shut(shutApply), sd(again));
  assert.equal(again.calls.filter((c) => c.startsWith('POST')).length, 0);
});

test('shutdown: absent resources are skipped, wrong project identity or label stops everything, unconfirmed pause fails', async () => {
  const absent = fakeCloud({ queue: null, job: null });
  assert.equal(await runShutdown(shut(shutApply), sd(absent)), EXIT.OK);
  assert.ok(!absent.calls.some((c) => c.startsWith('POST')));
  for (const bad of [fakeCloud({ labels: {} }), fakeCloud({ number: '999999999999' })]) {
    await rejects(() => runShutdown(shut(shutApply), sd(bad)), EXIT.REFUSED);
    assert.ok(!bad.calls.some((c) => c.startsWith('POST')));
  }
  const stuck = sd(fakeCloud({ stuck: true }));
  assert.equal(await runShutdown(shut(shutApply), stuck), EXIT.IO);
  assert.equal(stuck.io.lines.filter((l) => /NOT confirmed paused/.test(l)).length, 2, 'both targets are attempted and reported');
  const denied = fakeCloud();
  const base = denied.client;
  denied.client = async (host, path, ...rest) => { if (host === 'cloudscheduler' && path.endsWith(':pause')) throw new CloudError(403, 'PERMISSION_DENIED'); return base(host, path, ...rest); };
  const partial = sd(denied);
  assert.equal(await runShutdown(shut(shutApply), partial), EXIT.IO);
  assert.equal(denied.state.queue, 'PAUSED', 'queue is still paused after the scheduler failure');
  assert.ok(partial.io.lines.some((l) => /qp-reconcile: NOT confirmed paused: HTTP 403 PERMISSION_DENIED/.test(l)));
  assert.deepEqual(shutdownTargets(cfg).map((t) => t.id), ['qp-reconcile', 'qp-process']);
});

// ---- preflight ----
const realCtx = (over = {}) => ({
  read: (p) => readFileSync(join(root, p), 'utf8'), exists: (p) => existsSync(join(root, p)), listFiles: () => [],
  env: {}, tool: () => false, nodeVersion: 'v24.18.0', args: {}, ...over,
});
const status = (results, id) => results.find((r) => r.id === id)?.status;

test('preflight: repository passes, cloud items stay NOT_RUN and are never reported as passed', () => {
  const results = runPreflight(realCtx());
  assert.deepEqual(results.filter((r) => r.status === 'FAIL'), []);
  for (const id of ['repo-files', 'dockerfiles', 'ci-images', 'config-consistency', 'paused-defaults']) assert.equal(status(results, id), 'PASS', id);
  const notRun = results.filter((r) => r.status === 'NOT_RUN').map((r) => r.detail).join('\n');
  for (const needle of ['C1-C9', 'cloud deployment', 'Cloud Tasks', 'Google OAuth', 'Upstash', 'load tests']) assert.match(notRun, new RegExp(needle));
  assert.equal(status(results, 'tool-docker'), 'BLOCKED');
  assert.equal(summarize(results).exitCode, 0);
  assert.equal(summarize(results, true).exitCode, 2); // --strict turns BLOCKED into a failure
});

test('preflight: detects broken Dockerfiles, key files, missing artifacts and bad arguments', () => {
  const read = (p) => (p === 'apps/api/Dockerfile' ? readFileSync(join(root, p), 'utf8').replace('USER node', '') : readFileSync(join(root, p), 'utf8'));
  assert.equal(status(runPreflight(realCtx({ read })), 'dockerfiles'), 'FAIL');
  const leak = (p) => readFileSync(join(root, p), 'utf8').replace('ENV NODE_ENV=production', 'ENV NODE_ENV=production\nENV API_SECRET=abc');
  assert.equal(status(runPreflight(realCtx({ read: (p) => (p === 'apps/worker/Dockerfile' ? leak(p) : readFileSync(join(root, p), 'utf8')) })), 'dockerfiles'), 'FAIL');
  assert.equal(status(runPreflight(realCtx({ listFiles: () => ['apps/api/service-account-key.json', '.env.example', 'a/.env'] })), 'no-key-files'), 'FAIL');
  const pushing = (p) => readFileSync(join(root, p), 'utf8') + (p === '.github/workflows/ci.yml' ? '\n      - run: docker push x\n' : '');
  assert.equal(status(runPreflight(realCtx({ read: pushing })), 'ci-images'), 'FAIL');
  const noArtifacts = runPreflight(realCtx({ exists: (p) => !p.includes('/dist/') && existsSync(join(root, p)) }));
  assert.equal(status(noArtifacts, 'artifact-api'), 'BLOCKED');
  assert.equal(summarize(noArtifacts).exitCode, 0); // optional prerequisite
  assert.equal(status(runPreflight(realCtx({ args: { region: 'us-central1' } })), 'region-arg'), 'FAIL');
  const withConfig = (config, project) => status(runPreflight(realCtx({ args: { config: 'c', configText: JSON.stringify(config), project } })), 'config-file');
  assert.equal(withConfig(cfg, 'qp-demo-12345'), 'PASS');
  assert.equal(withConfig(cfg, 'other-project-1'), 'FAIL');
  assert.equal(withConfig({ ...cfg, projectId: 'replace-with-demo-project' }, undefined), 'BLOCKED');
  assert.equal(withConfig({ ...cfg, region: 'us-central1' }, undefined), 'FAIL');
});

test('preflight: reports secrets by name only and never prints values', () => {
  const secret = 'rediss://default:SuperSecretPassw0rd@example.upstash.io:6379';
  const results = runPreflight(realCtx({ env: { REDIS_URL: secret, GOOGLE_APPLICATION_CREDENTIALS: 'C:/keys/SuperSecretKey.json' } }));
  const text = JSON.stringify(results);
  assert.ok(!text.includes('SuperSecretPassw0rd') && !text.includes('SuperSecretKey') && !text.includes('upstash.io'));
  assert.equal(status(results, 'env-REDIS_URL'), 'PASS');
  assert.equal(status(results, 'cloud-secret-redis-url'), 'NOT_RUN');
});
