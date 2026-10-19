import assert from 'node:assert/strict';
/* global fetch, AbortSignal */
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { CloudError, getOrAbsent, matches, mergeBinding, reconcile, waitOperation } from './cloud.mjs';
import { indexes, readJson, specification, validateConfig } from './spec.mjs';
import { classifyTaskError, probe } from '../scripts/spike/probe.mjs';
import { spikeSpecification } from '../scripts/spike/setup.mjs';

const config = readJson('./config.example.json');
const resources = specification(config);

test('all infrastructure scripts parse in Node 24', () => {
  for (const folder of ['infra', 'scripts/spike']) {
    for (const file of readdirSync(folder).filter((f) => f.endsWith('.mjs'))) {
      const result = spawnSync(process.execPath, ['--check', `${folder}/${file}`], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
});

test('offline plans succeed without gcloud and cannot apply all stages', () => {
  for (const script of ['infra/apply.mjs', 'scripts/spike/setup.mjs', 'scripts/spike/probe.mjs']) {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).mode, /OFFLINE PLAN/);
  }
  const result = spawnSync(process.execPath, ['infra/apply.mjs', '--apply'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /placeholder/);
});

test('production, unknown config, unpinned images and cross-project images are rejected', () => {
  assert.throws(() => validateConfig({ ...config, environment: 'production' }));
  assert.throws(() => validateConfig({ ...config, QP_FAULT_CRASH: true }));
  assert.throws(() => validateConfig({ ...config, projectId: 'queuepilot-production' }, true));
  assert.throws(() => validateConfig(config, false, true));
  const good = { ...config, projectId: 'queuepilot-demo', apiImage: `europe-west1-docker.pkg.dev/queuepilot-demo/qp/api@sha256:${'a'.repeat(64)}`,
    workerImage: `europe-west1-docker.pkg.dev/queuepilot-demo/qp/worker@sha256:${'b'.repeat(64)}` };
  validateConfig(good, true, true);
  assert.throws(() => validateConfig({ ...good, redisSecretVersion: 'latest' }, true));
  assert.throws(() => validateConfig({ ...good, apiImage: good.apiImage.replace('queuepilot-demo/', 'other-project/') }, true, true));
});

test('Run deployment caps, secrets, OIDC and Scheduler match approved architecture', () => {
  for (const [id, max, concurrent, timeout] of [['qp-api', 5, 80, '15s'], ['qp-worker', 3, 10, '60s']]) {
    const template = resources.find((r) => r.stage === 'deploy' && r.id === id).body.template;
    assert.equal(template.scaling.maxInstanceCount, max);
    assert.equal(template.scaling.minInstanceCount, 0);
    assert.equal(template.maxInstanceRequestConcurrency, concurrent);
    assert.equal(template.timeout, timeout);
    const service = resources.find((r) => r.stage === 'deploy' && r.id === id).body;
    assert.equal(service.invokerIamDisabled, false);
    assert.equal(service.scaling.maxInstanceCount, max);
    const env = template.containers[0].env;
    assert.equal(env.find((e) => e.name === 'REDIS_URL').value, undefined);
    assert.equal(env.find((e) => e.name === 'QP_QUOTA_FAILURE_MODE').value, 'closed');
    assert.equal(env.find((e) => e.name === 'QP_ENV').value, 'production');
    assert.equal(env.some((e) => e.name.startsWith('QP_FAULT_')), false);
  }
  const queue = resources.find((r) => r.stage === 'queue').body;
  assert.deepEqual(queue.retryConfig, { maxAttempts: 10, maxRetryDuration: '600s', minBackoff: '2s', maxBackoff: '60s', maxDoublings: 4 });
  assert.deepEqual(queue.rateLimits, { maxDispatchesPerSecond: 20, maxConcurrentDispatches: 30 });
  const job = resources.find((r) => r.stage === 'scheduler').body;
  assert.equal(job.schedule, '* * * * *');
  assert.equal(job.httpTarget.oidcToken.audience, job.httpTarget.uri.replace('/internal/reconcile', ''));
});

test('least-privilege queue roles have exact create/get permission sets', () => {
  const role = (id) => resources.find((r) => r.id === id && r.kind === 'role').body.includedPermissions;
  assert.deepEqual(role('qpEnqueuer'), ['cloudtasks.tasks.create']);
  assert.deepEqual(role('qpReconciler'), ['cloudtasks.tasks.create', 'cloudtasks.tasks.get']);
  for (const r of resources.filter((r) => r.kind === 'iam')) {
    if (r.body.members.includes('allUsers')) assert.equal(r.id, 'api-public');
    if (r.body.role.startsWith('projects/')) assert.equal(r.host, 'cloudtasks');
    if (r.body.role === 'roles/secretmanager.secretAccessor') assert.match(r.path, /secrets\/redis-url$/);
  }
});

test('Firestore exemptions and TTL do not erase required composite fields', () => {
  assert.equal(indexes.indexes.length, 3);
  const ttls = indexes.fieldOverrides.filter((f) => f.ttl);
  assert.deepEqual(ttls.map((f) => f.collectionGroup).sort(), ['events', 'idempotencyKeys', 'requests']);
  assert.ok(ttls.every((f) => f.fieldPath === 'expiresAt' && f.indexes.length === 0));
  for (const field of ['processing', 'dispatch', 'description', 'watchdogAt']) {
    assert.ok(indexes.fieldOverrides.some((f) => f.collectionGroup === 'requests' && f.fieldPath === field && f.indexes.length === 0));
  }
  assert.equal(indexes.fieldOverrides.some((f) => ['tenantId', 'status'].includes(f.fieldPath)), false);
});

test('only explicit NOT_FOUND proves absence; failed reads never create resources', async () => {
  for (const error of [new CloudError(403, 'PERMISSION_DENIED'), new CloudError(429, 'RESOURCE_EXHAUSTED'),
    new CloudError(500, 'INTERNAL'), new CloudError(404, 'UNKNOWN'), new Error('timeout')]) {
    assert.equal(classifyTaskError(error), 'PROBE_UNKNOWN');
    let writes = 0;
    const client = async (_host, _path, method = 'GET') => { if (method !== 'GET') writes++; throw error; };
    await assert.rejects(() => getOrAbsent(client, 'cloudtasks', 'test'));
    await assert.rejects(() => reconcile(client, resources.find((r) => r.stage === 'queue')));
    assert.equal(writes, 0);
  }
  assert.equal(classifyTaskError(new CloudError(404, 'NOT_FOUND')), 'ABSENT');
  assert.equal(await getOrAbsent(async () => { throw new CloudError(404, 'NOT_FOUND'); }, 'cloudtasks', 'test'), null);
});

test('IAM merge preserves etag, conditional grants and unrelated bindings', async () => {
  const policy = { version: 3, etag: 'etag', bindings: [
    { role: 'roles/run.invoker', members: ['serviceAccount:existing'], condition: { title: 'conditional', expression: 'true' } },
    { role: 'roles/viewer', members: ['user:owner@example.test'] },
  ] };
  const resource = resources.find((r) => r.id === 'api-public');
  const merged = mergeBinding(policy, resource.body);
  assert.equal(merged.etag, 'etag');
  assert.deepEqual(merged.bindings.slice(0, 2), policy.bindings);
  assert.equal(policy.bindings.length, 2);
  assert.deepEqual(mergeBinding(merged, resource.body), merged);
  let writes = 0;
  assert.equal(await reconcile(async (_host, _path, method) => { if (method === 'POST') writes++; return merged; }, resource), 'NOOP');
  assert.equal(writes, 0);
});

test('public worker policy blocks IAM changes', async () => {
  const resource = resources.find((r) => r.id === 'worker-private');
  await assert.rejects(() => reconcile(async () => ({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] }), resource), /public IAM/);
});

test('queue routing overrides cannot silently replace per-task OIDC', async () => {
  const r = resources.find((r) => r.stage === 'queue');
  await assert.rejects(() => reconcile(async () => ({ ...r.body, httpTarget: { uriOverride: { host: 'unexpected.example' } } }), r), /routing\/authentication overrides/);
});

test('resource create, pause and repeat converge without extra mutations', async () => {
  for (const resource of resources.filter((r) => ['queue', 'deploy', 'scheduler'].includes(r.stage))) {
    let state = null;
    const writes = [];
    const client = async (_host, path, method = 'GET', body) => {
      if (method === 'GET') { if (!state) throw new CloudError(404, 'NOT_FOUND'); return state; }
      writes.push({ path, method });
      if (!path.endsWith(':pause')) state = { ...body, outputOnly: 'ignored' };
      return {};
    };
    assert.equal(await reconcile(client, resource), 'CREATED');
    const count = writes.length;
    assert.equal(count, ['cloudtasks', 'cloudscheduler'].includes(resource.host) ? 2 : 1);
    assert.equal(await reconcile(client, resource), 'NOOP');
    assert.equal(writes.length, count);
  }
  assert.ok(matches({ values: [{ name: 'b' }, { name: 'a' }] }, { values: [{ name: 'a' }, { name: 'b' }] }));
});

test('existing indexes match with server-added name and reordered JSON keys', async () => {
  const r = resources.find((r) => r.kind === 'index');
  const index = { ...r.body, state: 'READY', fields: r.body.fields.map((f) => ({ order: f.order, fieldPath: f.fieldPath })).concat({ fieldPath: '__name__', order: 'ASCENDING' }) };
  assert.equal(await reconcile(async () => ({ indexes: [index] }), r), 'NOOP');
});

test('active TTL and explicit exemptions converge; database drift stops', async () => {
  const r = resources.find((r) => r.kind === 'field' && r.body.ttlConfig);
  assert.equal(await reconcile(async () => ({ indexConfig: { indexes: [], usesAncestorConfig: false }, ttlConfig: { state: 'ACTIVE' } }), r), 'NOOP');
  assert.equal(await reconcile(async () => ({ indexConfig: {}, ttlConfig: { state: 'ACTIVE' } }), r), 'NOOP');
  const db = resources.find((r) => r.kind === 'database');
  await assert.rejects(() => reconcile(async () => ({ ...db.body, locationId: 'eur3' }), db), /refusing migration/);
});

test('ruleset fingerprints do not cause needless new releases', async () => {
  const r = resources.find((r) => r.kind === 'rules');
  const client = async (_host, path, method = 'GET') => {
    assert.equal(method, 'GET');
    if (path === r.path) return { rulesetName: 'projects/p/rulesets/existing' };
    return { source: { files: r.body.source.files.map((f) => ({ ...f, fingerprint: 'output-only' })) } };
  };
  assert.equal(await reconcile(client, r), 'NOOP');
});

test('completed operations are checked for errors, including serviceusage names', async () => {
  assert.deepEqual(await waitOperation(async () => { throw new Error('Must not poll'); }, 'serviceusage', { name: 'operations/test', done: true, response: { ok: true } }), { ok: true });
  await assert.rejects(() => waitOperation(async () => ({}), 'run', { name: 'projects/p/locations/r/operations/test', done: true, error: { code: 7 } }));
});

test('isolated probe resources and task payloads never target the main queue', async () => {
  const spike = spikeSpecification(config);
  assert.ok(spike.every((r) => !r.path.includes('/queues/qp-process')));
  assert.ok(spike.filter((r) => r.stage === 'deploy').every((r) => r.body.template.scaling.maxInstanceCount === 1));
  const result = await probe({ config: 'infra/config.example.json', queue: 'qp-spike-semantics', identity: 'qp-spike-reader', action: 'create', case: 'success' });
  assert.equal(result.task.dispatchDeadline, '30s');
  assert.match(result.task.httpRequest.oidcToken.serviceAccountEmail, /^qp-spike-invoker@/);
  await assert.rejects(() => probe({ config: 'infra/config.example.json', queue: 'qp-process', identity: 'qp-spike-reader', action: 'create', case: 'success' }));
});

test('public Hosting probe exposes only the synthetic header boolean', async (t) => {
  const child = fork('scripts/spike/server.mjs', { silent: true, execArgv: [],
    env: { ...process.env, QP_ENV: 'spike', K_SERVICE: 'qp-spike-hosting', PORT: '0' } });
  t.after(async () => { const closed = once(child, 'exit'); child.kill(); await closed; });
  let stdout = '';
  child.stdout.on('data', (data) => { stdout += data; });
  const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  const url = `http://127.0.0.1:${ready.port}`;
  const withHeader = await fetch(`${url}/api/auth-header`, {
    headers: { authorization: 'Bearer qp-spike-synthetic', cookie: 'do-not-log', description: 'do-not-log' }, signal: AbortSignal.timeout(2000),
  });
  assert.deepEqual(await withHeader.json(), { authorizationForwarded: true });
  const withoutHeader = await fetch(`${url}/api/auth-header`, { signal: AbortSignal.timeout(2000) });
  assert.deepEqual(await withoutHeader.json(), { authorizationForwarded: false });
  for (const path of ['/redis', '/probe/success/spike-public']) {
    const response = await fetch(`${url}${path}`, { method: 'POST', signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 404);
    await response.text();
  }
  assert.equal(stdout, '');
});

test('probe handler refuses production and fault-injection environments', () => {
  for (const env of [{ QP_ENV: 'production', K_SERVICE: 'qp-worker' },
    { QP_ENV: 'spike', K_SERVICE: 'qp-spike-worker', QP_FAULT_CRASH: '1' }]) {
    const result = spawnSync(process.execPath, ['scripts/spike/server.mjs'], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires QP_ENV=spike|Fault flags are forbidden/);
  }
});
