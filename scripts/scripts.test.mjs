/* global structuredClone */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CloudError } from '../infra/cloud.mjs';
import { EXIT, FirestoreRest, IdentityRest, ScriptError, maskEmail, resolveTarget, runCli, verifyCloudProject } from './lib/ops.mjs';
import { planDigest } from './lib/cloud-ops.mjs';
import { runPreflight, summarize } from './lib/preflight.mjs';
import { checkAccount, decideGrant, grantRole, parseGrantArgs } from './grant-role.mjs';
import { driftFields, parseSeedArgs, sandboxTenant, seedDemo } from './seed-demo.mjs';
import { parseDeployArgs, runDeploy } from './deploy.mjs';
import { parseShutdownArgs, runShutdown, shutdownTargets, withoutPublicInvoker } from './shutdown.mjs';
import { cloudSummary, dockerImagePath, runCloudPreflight } from './lib/cloud-preflight.mjs';
import { cloudPreflightMain, readOnly } from './preflight.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const EMU = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
const FS_ONLY = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
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
const googleUser = { localId: 'user-1', email: 'owner@example.test', emailVerified: true, disabled: false, providerUserInfo: [{ providerId: 'google.com' }] };
/** Auth double: answers lookups by uid or email from a fixed user list and records each query. */
const fakeIdentity = (users = [googleUser]) => {
  const queries = [];
  return { queries, lookup: async (q) => { queries.push(q); return users.filter((u) => (q.uid !== undefined ? u.localId === q.uid : u.email === q.email)); } };
};
const deps = (store, extra = {}) => {
  const identity = extra.identityDouble ?? fakeIdentity();
  return { io: io(), now: () => 1_700_000_000_000, cloudClient: noCloud, firestore: () => store, identity: () => identity, identityDouble: identity, ...extra };
};
const active = { name: 'T', status: 'active', openSignup: true, quotaMode: 'enforced', schemaVersion: 1 };
const argsFor = (list) => parseGrantArgs(list, EMU);
const apply = ['--project', 'demo-queuepilot', '--tenant', 'sandbox', '--uid', 'user-1', '--apply', '--approve-project', 'demo-queuepilot', '--approve-uid', 'user-1'];

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
  // Half-emulated targets are refused: an Auth emulator variable never combines with a real project or real Firestore.
  refuses(() => resolveTarget({ project: 'qp-demo-12345', env: { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' } }), EXIT.REFUSED);
  refuses(() => resolveTarget({ project: 'demo-queuepilot', env: { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' } }), EXIT.REFUSED);
  refuses(() => resolveTarget({ project: 'demo-queuepilot', env: { ...FS_ONLY, FIREBASE_AUTH_EMULATOR_HOST: 'auth.example.com:9099' } }), EXIT.REFUSED);
  refuses(() => resolveTarget({ project: 'demo-queuepilot', env: FS_ONLY, requireAuthEmulator: true }), EXIT.REFUSED);
  assert.equal(resolveTarget({ project: 'demo-queuepilot', env: FS_ONLY }).mode, 'emulator'); // seed needs Firestore only
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
  refuses(() => argsFor([...base, '--apply', '--approve-project', 'demo-queuepilot']), EXIT.REFUSED); // no --approve-uid
  refuses(() => argsFor([...base, '--approve-uid', 'a/b']), EXIT.USAGE);
  refuses(() => argsFor(['--project', 'demo-queuepilot', '--tenant', 'sandbox', '--email', 'not-an-email']), EXIT.USAGE);
  refuses(() => parseGrantArgs(base, FS_ONLY), EXIT.REFUSED); // the Auth emulator is required in emulator mode
  assert.equal(argsFor(['--project', 'demo-queuepilot', '--tenant', 'sandbox', '--email', 'owner@example.test']).email, 'owner@example.test');
});

test('grant-role: dry run is read-only, prints the resolved uid and the exact approval, never writes', async () => {
  const store = new FakeStore({ 'tenants/sandbox': active });
  const d = deps(store);
  assert.equal(await grantRole(argsFor(apply.slice(0, 6)), d), EXIT.OK);
  assert.deepEqual(store.writes, []);
  assert.deepEqual(store.reads, ['tenants/sandbox', 'memberships/user-1']);
  const text = d.io.lines.join('\n');
  assert.match(text, /DRY RUN \(read-only\).*project=demo-queuepilot.*tenant=sandbox.*uid=user-1/);
  assert.match(text, /Resolved user: uid=user-1 email=o\*\*\*@example\.test/);
  assert.match(text, /--apply --approve-project=demo-queuepilot --approve-uid=user-1/);
  assert.ok(!text.includes('owner@example.test'), 'the full email is never printed');
});

test('grant-role: --email resolves the uid; apply needs the matching --approve-uid', async () => {
  const byEmail = ['--project', 'demo-queuepilot', '--tenant', 'sandbox', '--email', 'owner@example.test'];
  const dry = deps(new FakeStore({ 'tenants/sandbox': active }));
  assert.equal(await grantRole(argsFor(byEmail), dry), EXIT.OK);
  assert.deepEqual(dry.identityDouble.queries, [{ email: 'owner@example.test' }]);
  const wrong = new FakeStore({ 'tenants/sandbox': active });
  await rejects(() => grantRole(argsFor([...byEmail, '--apply', '--approve-project', 'demo-queuepilot', '--approve-uid', 'someone-else']), deps(wrong)), EXIT.REFUSED);
  assert.deepEqual(wrong.writes, []);
  const right = new FakeStore({ 'tenants/sandbox': active });
  assert.equal(await grantRole(argsFor([...byEmail, '--apply', '--approve-project', 'demo-queuepilot', '--approve-uid', 'user-1']), deps(right)), EXIT.OK);
  assert.deepEqual(right.writes.map((w) => w[1]), ['memberships/user-1']);
  assert.equal(maskEmail('a@b.c'), 'a***@b.c'); assert.equal(maskEmail(undefined), '(none)');
});

test('grant-role: account checks (missing, ambiguous, disabled, unverified, non-Google, uid/email mismatch) stop before Firestore', async () => {
  const cases = [
    [], [googleUser, { ...googleUser, localId: 'user-2' }], [{ ...googleUser, disabled: true }], [{ ...googleUser, emailVerified: false }],
    [{ ...googleUser, providerUserInfo: [{ providerId: 'password' }] }], [{ ...googleUser, providerUserInfo: undefined }],
  ];
  for (const users of cases) {
    const store = new FakeStore({ 'tenants/sandbox': active });
    await rejects(() => grantRole(argsFor(apply), deps(store, { identityDouble: { lookup: async () => users } })), EXIT.STATE);
    assert.deepEqual([store.reads, store.writes], [[], []]);
  }
  assert.match(checkAccount([googleUser], { uid: 'user-1', email: 'other@example.test' }), /different users/);
  assert.match(checkAccount([googleUser], { uid: 'user-9' }), /different users/);
  assert.equal(checkAccount([googleUser], { uid: 'user-1', email: 'OWNER@example.test' }), null);
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
  const cloudArgs = ['--project', 'qp-demo-12345', '--tenant', 'sandbox', '--uid', 'user-1', '--apply', '--approve-project', 'qp-demo-12345', '--approve-uid', 'user-1'];
  for (const info of [{ ...ok, labels: {} }, { ...ok, lifecycleState: 'DELETE_REQUESTED' }, { ...ok, projectId: 'someone-else-1' }]) {
    const store = new FakeStore({ 'tenants/sandbox': active });
    const d = deps(store, { cloudClient: () => async () => info });
    await rejects(() => grantRole(parseGrantArgs(cloudArgs, {}), d), EXIT.REFUSED);
    assert.deepEqual(store.reads, []); assert.deepEqual(store.writes, []);
    assert.deepEqual(d.identityDouble.queries, [], 'no Auth lookup before the project is verified');
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

test('IdentityRest: read-only lookup, emulator vs cloud headers, errors never echo bodies', async () => {
  const calls = [];
  const respond = (status, body) => async (url, init) => { calls.push({ url, init }); return { status, json: async () => body }; };
  const emulator = { mode: 'emulator', project: 'demo-queuepilot', emulatorHost: '127.0.0.1:8080', authEmulatorHost: '127.0.0.1:9099' };
  const users = await new IdentityRest({ target: emulator, token: noCloud, fetchImpl: respond(200, { users: [googleUser] }) }).lookup({ uid: 'user-1' });
  assert.deepEqual(users, [googleUser]);
  assert.equal(calls[0].url, 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/demo-queuepilot/accounts:lookup');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { localId: ['user-1'] });
  assert.equal(calls[0].init.headers.authorization, 'Bearer owner');
  const cloud = { mode: 'cloud', project: 'qp-demo-12345' };
  assert.deepEqual(await new IdentityRest({ target: cloud, token: async () => 'tkn', fetchImpl: respond(200, {}) }).lookup({ email: 'a@b.cd' }), []);
  assert.equal(calls[1].url, 'https://identitytoolkit.googleapis.com/v1/projects/qp-demo-12345/accounts:lookup');
  assert.equal(calls[1].init.headers['x-goog-user-project'], 'qp-demo-12345');
  assert.deepEqual(JSON.parse(calls[1].init.body), { email: ['a@b.cd'] });
  await assert.rejects(new IdentityRest({ target: cloud, token: async () => 'tkn', fetchImpl: respond(403, { error: { status: 'PERMISSION_DENIED', message: 'secret-xyz' } }) }).lookup({ uid: 'u' }),
    (error) => error.exitCode === EXIT.IO && /PERMISSION_DENIED/.test(error.message) && !/secret-xyz|tkn/.test(error.message));
});

test('runCli maps errors to exit codes without leaking unexpected details', async () => {
  const out = io();
  assert.equal(await runCli(async () => { throw new ScriptError(EXIT.REFUSED, 'nope'); }, [], out), EXIT.REFUSED);
  assert.equal(await runCli(async () => { throw new Error('token=abc123'); }, [], out), EXIT.IO);
  assert.ok(!out.lines.join('\n').includes('abc123'));
});

test('seed-demo: explicit signup choice, dry run, idempotency, DRIFT without overwrite, never memberships', async () => {
  const seed = (list) => parseSeedArgs(list, FS_ONLY);
  const base = ['--project', 'demo-queuepilot', '--open-signup', 'false'];
  refuses(() => seed(['--project', 'demo-queuepilot']), EXIT.USAGE); // signup must be a conscious choice
  refuses(() => seed([...base.slice(0, 2), '--open-signup', 'maybe']), EXIT.USAGE);
  refuses(() => seed([...base, '--apply']), EXIT.REFUSED);
  refuses(() => seed([...base, '--apply', '--approve-project', 'demo-other']), EXIT.REFUSED); // wrong project
  refuses(() => seed([...base, '--member-uid', 'user-1']), EXIT.USAGE); // memberships are not the seed's job

  const dry = new FakeStore();
  assert.equal(await seedDemo(seed(base), deps(dry, { firestore: noCloud })), EXIT.OK);
  assert.deepEqual([dry.reads, dry.writes], [[], []]);

  const store = new FakeStore();
  const applyArgs = [...base, '--apply', '--approve-project', 'demo-queuepilot'];
  assert.equal(await seedDemo(seed(applyArgs), deps(store)), EXIT.OK);
  assert.deepEqual(store.writes.map((w) => w[1]), ['tenants/sandbox']);
  assert.deepEqual(store.writes[0][2], sandboxTenant(false));
  assert.equal(await seedDemo(seed(applyArgs), deps(store)), EXIT.OK); // rerun: no further writes
  assert.equal(store.writes.length, 1);

  store.docs.get('tenants/sandbox').data = { ...sandboxTenant(true), extra: 'x' }; // drift is reported, not overwritten
  const drifted = deps(store);
  assert.equal(await seedDemo(seed(applyArgs), drifted), EXIT.STATE);
  assert.match(drifted.io.lines.join('\n'), /DRIFT tenants\/sandbox: fields differ from the seed: extra, openSignup\. Not overwriting/);
  assert.equal(store.writes.length, 1);
  assert.deepEqual(driftFields({ a: { b: 1 } }, { a: { b: 1 } }), []);
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

/** Cloud double for the optional public-API revocation: queue/job already paused, qp-api policy held in memory. */
function revokeCloud({ policy, absent = false, stuck = false } = {}) {
  const calls = [];
  const state = { policy: structuredClone(policy) };
  const runPath = `v2/projects/${cfg.projectId}/locations/${cfg.region}/services/qp-api`;
  const client = async (host, path, method = 'GET', body) => {
    calls.push(`${method} ${host} ${path}`);
    if (host === 'cloudresourcemanager') return { projectId: cfg.projectId, projectNumber: cfg.projectNumber, lifecycleState: 'ACTIVE', labels: { 'queuepilot-environment': 'demo' } };
    if (host !== 'run') return { state: 'PAUSED' };
    assert.ok(path.startsWith(runPath), `only qp-api is touched: ${path}`);
    if (absent) throw new CloudError(404, 'NOT_FOUND');
    if (method === 'GET') { assert.match(path, /:getIamPolicy\?options\.requestedPolicyVersion=3$/); return structuredClone(state.policy); }
    assert.ok(path.endsWith(':setIamPolicy'));
    assert.equal(body.policy.etag, state.policy.etag, 'the read etag is sent back');
    if (!stuck) state.policy = { ...body.policy, etag: 'next' };
    return state.policy;
  };
  return { calls, state, client };
}

test('shutdown --revoke-public-api: removes only allUsers from unconditional run.invoker on qp-api and confirms by re-read', async () => {
  const policy = { etag: 'e1', version: 3, bindings: [
    { role: 'roles/run.invoker', members: ['allUsers', 'serviceAccount:keep@x.iam.gserviceaccount.com'] },
    { role: 'roles/run.invoker', members: ['allUsers'], condition: { title: 'c', expression: 'true' } },
    { role: 'roles/run.viewer', members: ['allUsers'] },
  ] };
  const without = withoutPublicInvoker(policy);
  assert.deepEqual(without.bindings[0].members, ['serviceAccount:keep@x.iam.gserviceaccount.com']);
  assert.deepEqual(without.bindings.slice(1), policy.bindings.slice(1), 'conditional and other-role bindings are untouched');
  assert.equal(without.etag, 'e1');
  assert.deepEqual(withoutPublicInvoker({ etag: 'e', bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] }).bindings, []);

  const dryCloud = revokeCloud({ policy });
  const dry = { io: io(), readFile: () => cfgText, client: noCloud };
  assert.equal(await runShutdown(shut(['--revoke-public-api']), dry), EXIT.OK);
  assert.match(dry.io.lines.join('\n'), /remove the allUsers roles\/run.invoker binding from qp-api/);
  assert.deepEqual(dryCloud.calls, []);

  const cloud = revokeCloud({ policy: { etag: 'e1', bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] } });
  const d = { io: io(), readFile: () => cfgText, client: () => cloud.client };
  assert.equal(await runShutdown(shut([...shutApply, '--revoke-public-api']), d), EXIT.OK);
  assert.deepEqual(cloud.state.policy.bindings, []);
  assert.equal(cloud.calls.filter((c) => c.includes(':setIamPolicy')).length, 1);
  assert.match(d.io.lines.join('\n'), /allUsers invoker removed \(confirmed by re-read\)/);

  const plain = revokeCloud({ policy: { etag: 'e1', bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] } });
  await runShutdown(shut(shutApply), { io: io(), readFile: () => cfgText, client: () => plain.client });
  assert.ok(!plain.calls.some((c) => c.includes(' run ')), 'without the flag qp-api IAM is never read or changed');

  const priv = revokeCloud({ policy: { etag: 'e1', bindings: [] } });
  assert.equal(await runShutdown(shut([...shutApply, '--revoke-public-api']), { io: io(), readFile: () => cfgText, client: () => priv.client }), EXIT.OK);
  assert.ok(!priv.calls.some((c) => c.includes(':setIamPolicy')));
  const absent = revokeCloud({ absent: true });
  assert.equal(await runShutdown(shut([...shutApply, '--revoke-public-api']), { io: io(), readFile: () => cfgText, client: () => absent.client }), EXIT.OK);
  const stuck = revokeCloud({ stuck: true, policy: { etag: 'e1', bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] } });
  const failing = { io: io(), readFile: () => cfgText, client: () => stuck.client };
  assert.equal(await runShutdown(shut([...shutApply, '--revoke-public-api']), failing), EXIT.IO);
  assert.match(failing.io.lines.join('\n'), /public access NOT confirmed revoked/);
});

// ---- cloud preflight (read-only) ----
const loc = `projects/${cfg.projectId}/locations/${cfg.region}`;
/** Healthy, fully provisioned demo project as GET answers keyed by host and path. */
function preflightCloud(overrides = {}) {
  const calls = [];
  const answers = {
    [`cloudresourcemanager v1/projects/${cfg.projectId}`]: { projectId: cfg.projectId, projectNumber: cfg.projectNumber, lifecycleState: 'ACTIVE', labels: { 'queuepilot-environment': 'demo' } },
    [`cloudbilling v1/projects/${cfg.projectId}/billingInfo`]: { billingEnabled: true },
    [`firestore v1/projects/${cfg.projectId}/databases/(default)`]: { locationId: 'europe-west1', type: 'FIRESTORE_NATIVE', deleteProtectionState: 'DELETE_PROTECTION_ENABLED' },
    [`secretmanager v1/projects/${cfg.projectId}/secrets/redis-url/versions/1`]: { state: 'ENABLED' },
    [`cloudtasks v2/${loc}/queues/qp-process`]: { state: 'PAUSED' },
    [`cloudscheduler v1/${loc}/jobs/qp-reconcile`]: { state: 'PAUSED' },
    [`run v2/${loc}/services/qp-worker`]: { template: { containers: [{ image: cfg.workerImage }] } },
    [`run v2/${loc}/services/qp-api`]: { template: { containers: [{ image: cfg.apiImage }] } },
    [`run v2/${loc}/services/qp-worker:getIamPolicy?options.requestedPolicyVersion=3`]: { bindings: [{ role: 'roles/run.invoker', members: ['serviceAccount:qp-tasks-invoker-sa@x'] }] },
    [`run v2/${loc}/services/qp-api:getIamPolicy?options.requestedPolicyVersion=3`]: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] },
    ...overrides,
  };
  const client = async (host, path, method = 'GET', body) => {
    calls.push({ host, path, method, body });
    const key = `${host} ${path}`;
    if (host === 'serviceusage' && !(key in answers)) return { state: 'ENABLED' };
    if (host === 'artifactregistry' && !(key in answers)) return { name: path };
    const value = answers[key];
    if (value instanceof Error) throw value;
    if (value === undefined || value === null) throw new CloudError(404, 'NOT_FOUND');
    return value;
  };
  return { calls, client };
}
const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r.status]));

test('cloud preflight: a matching project passes and every request is a body-less GET', async () => {
  const cloud = preflightCloud();
  const results = await runCloudPreflight(cfg, readOnly(cloud.client));
  assert.deepEqual(results.filter((r) => r.status !== 'PASS'), []);
  assert.equal(cloudSummary(results).exitCode, 0);
  assert.ok(cloud.calls.every((c) => c.method === 'GET' && c.body === undefined));
  assert.ok(cloud.calls.some((c) => c.host === 'artifactregistry' && c.path.endsWith(`/repositories/queuepilot/dockerImages/api%40sha256%3A${digest64}`)));
  assert.equal(dockerImagePath(cfg, 'europe-west1-docker.pkg.dev/other-project/queuepilot/api@sha256:' + digest64), null);
  await assert.rejects(readOnly(cloud.client)('run', 'x:setIamPolicy', 'POST', {}), (error) => error.exitCode === EXIT.IO);
  assert.equal(cloud.calls.at(-1).method, 'GET', 'the refused write never reached the client');
});

test('cloud preflight: identity doubt stops all reads; contradictions FAIL; denials stay UNKNOWN; missing is ABSENT', async () => {
  for (const crm of [{ projectId: cfg.projectId, projectNumber: '999999999999', lifecycleState: 'ACTIVE', labels: { 'queuepilot-environment': 'demo' } },
    { projectId: cfg.projectId, projectNumber: cfg.projectNumber, lifecycleState: 'ACTIVE', labels: {} }, new CloudError(403, 'PERMISSION_DENIED')]) {
    const cloud = preflightCloud({ [`cloudresourcemanager v1/projects/${cfg.projectId}`]: crm });
    const results = await runCloudPreflight(cfg, readOnly(cloud.client));
    assert.equal(results.length, 1);
    assert.equal(cloud.calls.length, 1, 'nothing else is read after an identity problem');
    assert.notEqual(cloudSummary(results).exitCode, 0);
  }
  const bad = preflightCloud({
    [`cloudbilling v1/projects/${cfg.projectId}/billingInfo`]: new CloudError(403, 'PERMISSION_DENIED'),
    [`firestore v1/projects/${cfg.projectId}/databases/(default)`]: { locationId: 'eur3', type: 'FIRESTORE_NATIVE' },
    [`cloudtasks v2/${loc}/queues/qp-process`]: { state: 'RUNNING' },
    [`cloudscheduler v1/${loc}/jobs/qp-reconcile`]: null,
    [`run v2/${loc}/services/qp-worker:getIamPolicy?options.requestedPolicyVersion=3`]: { bindings: [{ role: 'roles/run.invoker', members: ['allAuthenticatedUsers'] }] },
    [`run v2/${loc}/services/qp-api`]: { template: { containers: [{ image: 'europe-west1-docker.pkg.dev/qp-demo-12345/queuepilot/api@sha256:' + 'b'.repeat(64) }] } },
  });
  const status = byId(await runCloudPreflight(cfg, readOnly(bad.client)));
  assert.deepEqual([status.billing, status.firestore, status['qp-process'], status['qp-reconcile'], status['run-iam:qp-worker'], status['run:qp-api']],
    ['UNKNOWN', 'FAIL', 'FAIL', 'ABSENT', 'FAIL', 'FAIL']);
  const unknownOnly = byId(await runCloudPreflight(cfg, readOnly(preflightCloud({ [`cloudbilling v1/projects/${cfg.projectId}/billingInfo`]: new CloudError(403, 'PERMISSION_DENIED') }).client)));
  assert.equal(unknownOnly.billing, 'UNKNOWN');
  assert.equal(cloudSummary([{ status: 'UNKNOWN' }]).exitCode, 3);
  assert.equal(cloudSummary([{ status: 'ABSENT' }]).exitCode, 0);
});

test('cloud preflight CLI: needs config, exact project approval and the approved region before any request', async () => {
  const cloud = preflightCloud();
  const run = (values) => cloudPreflightMain({ config: 'c.json', project: cfg.projectId, region: 'europe-west1', ...values }, io(), { readFile: () => cfgText, client: () => cloud.client });
  await rejects(() => run({ 'approve-project': undefined }), EXIT.REFUSED);
  await rejects(() => run({ 'approve-project': 'other-project-1' }), EXIT.REFUSED);
  await rejects(() => run({ 'approve-project': cfg.projectId, region: 'asia-east1' }), EXIT.REFUSED);
  await rejects(() => run({ config: undefined, 'approve-project': cfg.projectId }), EXIT.USAGE);
  assert.deepEqual(cloud.calls, []);
  assert.equal(await run({ 'approve-project': cfg.projectId }), 0);
  assert.ok(cloud.calls.length > 10 && cloud.calls.every((c) => c.method === 'GET'));
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
