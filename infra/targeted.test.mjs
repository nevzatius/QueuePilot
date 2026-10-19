/* global structuredClone */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CloudError, cloudClient, reconcile } from './cloud.mjs';
import { readJson, specification } from './spec.mjs';
import { spikeSpecification } from '../scripts/spike/setup.mjs';

const config = { ...readJson('./config.example.json'), projectId: 'queuepilot-demo',
  apiImage: `europe-west1-docker.pkg.dev/queuepilot-demo/queuepilot/api@sha256:${'b'.repeat(64)}`,
  workerImage: `europe-west1-docker.pkg.dev/queuepilot-demo/queuepilot/worker@sha256:${'a'.repeat(64)}` };
const resources = specification(config);
const queue = resources.find((r) => r.stage === 'queue');
const scheduler = resources.find((r) => r.stage === 'scheduler');
const database = resources.find((r) => r.kind === 'database');
const readyWorker = { terminalCondition: { state: 'CONDITION_SUCCEEDED' },
  latestReadyRevision: 'ready', latestCreatedRevision: 'ready', template: { containers: [{ image: config.workerImage }] } };

test('IAM REST methods, exact URLs and serialized bodies preserve policies for all resource types', async (t) => {
  const cases = [
    ['qp-api-sa-actas', 'iam', 'POST', 'v1/projects/queuepilot-demo/serviceAccounts/qp-tasks-invoker-sa@queuepilot-demo.iam.gserviceaccount.com', true],
    ['qp-api-sa-queue', 'cloudtasks', 'POST', 'v2/projects/queuepilot-demo/locations/europe-west1/queues/qp-process', false],
    ['qp-api-sa-data', 'cloudresourcemanager', 'POST', 'v1/projects/queuepilot-demo', false],
    ['worker-private', 'run', 'GET', 'v2/projects/queuepilot-demo/locations/europe-west1/services/qp-worker', true],
    ['qp-api-sa-redis', 'secretmanager', 'GET', 'v1/projects/queuepilot-demo/secrets/redis-url', true],
  ];
  for (const [id, host, method, path, query] of cases) {
    const r = resources.find((r) => r.id === id);
    const original = { version: 3, etag: 'etag', auditConfigs: [{ service: 'allServices' }], bindings: [
      { role: r.body.role, members: ['user:existing@example.test'] },
      { role: r.body.role, members: ['user:conditional@example.test'], condition: { title: 'conditional', expression: 'true' } },
      { role: 'roles/viewer', members: ['user:owner@example.test'] },
    ] };
    let policy = structuredClone(original);
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      if (url.endsWith(':setIamPolicy')) policy = JSON.parse(options.body).policy;
      return { status: 200, ok: true, json: async () => structuredClone(policy) };
    });
    const client = cloudClient('offline-placeholder');
    assert.equal(await reconcile(client, r), 'UPDATED');
    const read = { url: `https://${host}.googleapis.com/${path}:getIamPolicy${query ? '?options.requestedPolicyVersion=3' : ''}`,
      method, body: query ? undefined : JSON.stringify({ options: { requestedPolicyVersion: 3 } }) };
    assert.deepEqual(calls[0], read);
    const expected = structuredClone(original);
    expected.bindings[0].members = [...original.bindings[0].members, ...r.body.members].sort();
    assert.deepEqual(calls[1], { url: `https://${host}.googleapis.com/${path}:setIamPolicy`, method: 'POST', body: JSON.stringify({ policy: expected }) });
    assert.deepEqual(policy, expected);
    assert.deepEqual(original.bindings[0].members, ['user:existing@example.test']);
    assert.equal(await reconcile(client, r), 'NOOP');
    assert.deepEqual(calls, [read, calls[1], read]);
    t.mock.restoreAll();
  }
});

test('all main and spike IAM call sites use the resource mapping and never write matching policies', async () => {
  for (const r of [...resources, ...spikeSpecification(config)].filter((r) => r.kind === 'iam')) {
    const calls = [];
    assert.equal(await reconcile(async (host, path, method, body) => {
      calls.push({ host, path, method, body });
      return { version: 3, etag: 'unchanged', bindings: [r.body] };
    }, r), 'NOOP');
    const query = ['iam', 'run', 'secretmanager'].includes(r.host);
    assert.deepEqual(calls, [{ host: r.host, path: `${r.path}:getIamPolicy${query ? '?options.requestedPolicyVersion=3' : ''}`,
      method: ['run', 'secretmanager'].includes(r.host) ? 'GET' : 'POST',
      body: query ? undefined : { options: { requestedPolicyVersion: 3 } } }]);
  }
  await assert.rejects(() => reconcile(async () => assert.fail('Unsupported IAM must not call cloud'),
    { kind: 'iam', host: 'iam', path: 'v1/projects/p/roles/r' }), /Unsupported IAM/);
});

test('IAM read failures cannot trigger policy writes, including POST policy reads', async () => {
  for (const r of resources.filter((r) => r.kind === 'iam')) {
    for (const error of [new CloudError(403, 'PERMISSION_DENIED'), new CloudError(404, 'NOT_FOUND'), new Error('timeout')]) {
      let count = 0;
      await assert.rejects(() => reconcile(async (_host, path) => {
        count++;
        assert.match(path, /:getIamPolicy/);
        throw error;
      }, r), (actual) => actual === error);
      assert.equal(count, 1);
    }
  }
});

test('absent main and isolated Scheduler jobs are deferred without explicit target approval', async () => {
  for (const r of [scheduler, spikeSpecification(config).find((r) => r.stage === 'scheduler')]) {
    let reads = 0;
    const result = await reconcile(async (host, path, method = 'GET') => {
      reads++;
      assert.deepEqual([host, path, method], ['cloudscheduler', r.path, 'GET']);
      throw new CloudError(404, 'NOT_FOUND');
    }, r);
    assert.match(result, /^DEFERRED \(state=ABSENT/);
    assert.equal(reads, 1);
  }
});

test('Scheduler approval must match a fully ready deployed target before any job creation', async () => {
  for (const worker of [null, { ...readyWorker, reconciling: true }, { ...readyWorker, terminalCondition: { state: 'CONDITION_FAILED' } },
    { ...readyWorker, latestReadyRevision: 'old' }, { ...readyWorker, latestCreatedRevision: undefined },
    { ...readyWorker, template: { containers: [{ image: config.apiImage }] } }]) {
    const client = async (host, path, method = 'GET') => {
      assert.equal(method, 'GET');
      if (host === 'cloudscheduler') throw new CloudError(404, 'NOT_FOUND');
      assert.equal(path, scheduler.targetService);
      if (!worker) throw new CloudError(404, 'NOT_FOUND');
      return worker;
    };
    await assert.rejects(() => reconcile(client, scheduler, { schedulerImage: config.workerImage }));
  }
  await assert.rejects(() => reconcile(async () => { throw new CloudError(404, 'NOT_FOUND'); }, scheduler,
    { schedulerImage: config.apiImage }), /approval must match/);
});

test('existing active resources are paused before drift checks, and reapplication observes PAUSED', async () => {
  for (const r of [queue, scheduler]) {
    let state = { ...r.body, state: r.host === 'cloudtasks' ? 'RUNNING' : 'ENABLED' };
    const calls = [];
    const client = async (host, path, method = 'GET', body) => {
      calls.push({ host, path, method, body });
      if (method === 'POST') {
        assert.equal(path, `${r.path}:pause`);
        assert.deepEqual(body, {});
        state = { ...state, state: 'PAUSED' };
      }
      return state;
    };
    assert.equal(await reconcile(client, r), 'PAUSED (state=PAUSED)');
    assert.deepEqual(calls.map((c) => [c.path, c.method]), [[r.path, 'GET'], [`${r.path}:pause`, 'POST'], [r.path, 'GET']]);
    assert.equal(await reconcile(client, r), 'NOOP (state=PAUSED)');
    assert.equal(calls.length, 4);
  }
});

test('new and existing queue/job pause failures or unconfirmed states fail closed', async () => {
  for (const r of [queue, scheduler]) for (const existing of [false, true]) for (const fails of [false, true]) {
    let present = existing;
    const client = async (host, path, method = 'GET') => {
      if (host === 'run') return readyWorker;
      if (method === 'GET') {
        if (!present) throw new CloudError(404, 'NOT_FOUND');
        return { ...r.body, state: r.host === 'cloudtasks' ? 'RUNNING' : 'ENABLED' };
      }
      if (path.endsWith(':pause') && fails) throw new CloudError(403, 'PERMISSION_DENIED');
      present = true;
      return {};
    };
    await assert.rejects(() => reconcile(client, r, { schedulerImage: config.workerImage }), /PERMISSION_DENIED|pause not confirmed/);
  }
  for (const r of [queue, scheduler]) for (const state of [undefined, 'DISABLED', 'STATE_UNSPECIFIED']) {
    await assert.rejects(() => reconcile(async (_host, _path, method = 'GET') => {
      assert.equal(method, 'GET');
      return { ...r.body, state };
    }, r), /unsafe or unknown state/);
  }
});

test('Scheduler omitted/default retry responses converge without updates and retry drift is corrected once', async () => {
  for (const retryConfig of [undefined, {}, { retryCount: 0 }, { maxRetryDuration: '0.000000000s' },
    { retryCount: 0, maxRetryDuration: '0s', minBackoffDuration: '5s', maxBackoffDuration: '3600s', maxDoublings: 5 },
    { retryCount: 0, maxRetryDuration: '0s', minBackoffDuration: '5s', maxBackoffDuration: '60s', maxDoublings: 3 }]) {
    assert.equal(await reconcile(async (_host, _path, method = 'GET') => {
      assert.equal(method, 'GET', 'Matching normalized policy must not write');
      return { ...scheduler.body, state: 'PAUSED', attemptDeadline: '60.000s', retryConfig };
    }, scheduler), 'NOOP (state=PAUSED)');
  }
  for (const retryConfig of [{ retryCount: 1 }, { maxRetryDuration: '60s' }]) {
    let state = { ...scheduler.body, state: 'PAUSED', retryConfig };
    let updates = 0;
    const client = async (_host, path, method = 'GET', body) => {
      if (method === 'PATCH') {
        updates++;
        assert.match(path, /updateMask=.*retryConfig/);
        assert.deepEqual(body.retryConfig, { retryCount: 0, maxRetryDuration: '0s' });
        state = { ...body, state: 'PAUSED', retryConfig: { minBackoffDuration: '5s', maxBackoffDuration: '3600s', maxDoublings: 5 } };
      } else assert.equal(method, 'GET');
      return state;
    };
    assert.equal(await reconcile(client, scheduler), 'UPDATED (state=PAUSED)');
    assert.equal(await reconcile(client, scheduler), 'NOOP (state=PAUSED)');
    assert.equal(updates, 1);
  }
});

test('database creation requires matching project and irreversible region approval at the write boundary', async () => {
  for (const approvals of [{}, { projectId: config.projectId }, { firestoreLocation: 'europe-west1' },
    { projectId: 'other-project', firestoreLocation: 'europe-west1' }, { projectId: config.projectId, firestoreLocation: 'eur3' }]) {
    await assert.rejects(() => reconcile(async (_host, _path, method = 'GET') => {
      assert.equal(method, 'GET');
      throw new CloudError(404, 'NOT_FOUND');
    }, database, approvals), /exact project.*location approval/);
  }
  const calls = [];
  assert.equal(await reconcile(async (host, path, method = 'GET', body) => {
    calls.push({ host, path, method, body });
    if (method === 'GET') throw new CloudError(404, 'NOT_FOUND');
    return {};
  }, database, { projectId: config.projectId, firestoreLocation: 'europe-west1' }), 'CREATED');
  assert.deepEqual(calls[1], { host: 'firestore', path: 'v1/projects/queuepilot-demo/databases?databaseId=(default)', method: 'POST',
    body: { locationId: 'europe-west1', type: 'FIRESTORE_NATIVE', deleteProtectionState: 'DELETE_PROTECTION_ENABLED' } });
});

test('pending index operations and CREATING TTL are PENDING until state reads prove readiness', async () => {
  const r = resources.find((r) => r.kind === 'index');
  for (const operation of [{ name: 'projects/p/databases/(default)/operations/index', done: false },
    { name: 'projects/p/databases/(default)/operations/index', done: true, response: { state: 'CREATING' } }]) {
    let created = false;
    let state = 'CREATING';
    const client = async (_host, path, method = 'GET', body) => {
      if (method === 'POST') {
        assert.equal(created, false, 'No duplicate index creation');
        assert.equal(path, r.parent);
        assert.deepEqual(body, r.body);
        created = true;
        return operation;
      }
      assert.equal(path, r.path, 'No polling can mistake a pending operation for a ready index');
      return { indexes: created ? [{ ...r.body, state }] : [] };
    };
    assert.equal(await reconcile(client, r), 'PENDING');
    assert.equal(await reconcile(client, r), 'PENDING');
    state = 'READY';
    assert.equal(await reconcile(client, r), 'NOOP');
    state = 'NEEDS_REPAIR';
    await assert.rejects(() => reconcile(client, r), /repair/);
  }
  const field = resources.find((r) => r.kind === 'field' && r.body.ttlConfig);
  assert.equal(await reconcile(async () => ({ indexConfig: { indexes: [], usesAncestorConfig: false }, ttlConfig: { state: 'CREATING' } }), field), 'PENDING');
  assert.equal(await reconcile(async () => ({ indexConfig: { indexes: [], reverting: true }, ttlConfig: { state: 'ACTIVE' } }), field), 'PENDING');
});

test('TTL exemptions and TTL policy are patched together and asynchronous operations never imply completion', async () => {
  for (const r of resources.filter((r) => r.kind === 'field' && r.body.ttlConfig)) {
    const calls = [];
    assert.equal(await reconcile(async (host, path, method = 'GET', body) => {
      calls.push({ host, path, method, body });
      if (method === 'GET') return { indexConfig: { usesAncestorConfig: true } };
      return { name: 'projects/p/databases/(default)/operations/field', done: false };
    }, r), 'PENDING');
    assert.deepEqual(calls[1], { host: 'firestore', path: `${r.path}?updateMask=indexConfig,ttlConfig`, method: 'PATCH',
      body: { indexConfig: { indexes: [] }, ttlConfig: {} } });
    assert.equal(await reconcile(async () => ({ indexConfig: { indexes: [] }, ttlConfig: { state: 'ACTIVE' } }), r), 'NOOP');
  }
  for (const r of resources.filter((r) => ['index', 'field'].includes(r.kind))) {
    await assert.rejects(() => reconcile(async (_host, _path, method = 'GET') => method === 'GET'
      ? (r.kind === 'index' ? { indexes: [] } : { indexConfig: { usesAncestorConfig: true } })
      : { name: 'operations/failed', done: true, error: { code: 7 } }, r), /HTTP 500 7/);
  }
});

test('CLI rejects absent/inconsistent approvals before credentials, and pause errors produce nonzero exit codes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'queuepilot-b21-'));
  try {
    const path = join(directory, 'config.json');
    writeFileSync(path, JSON.stringify(config));
    for (const flags of [[], ['--approve-firestore-location=eur3'], ['--approve-firestore-location=europe-west1', '--approve-project=other-project']]) {
      const result = spawnSync(process.execPath, ['infra/apply.mjs', '--config', path, '--stage=data', '--apply',
        `--approve-project=${config.projectId}`, ...flags], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /approve-firestore-location|approve-project/);
      assert.doesNotMatch(result.stderr, /gcloud|ENOENT/);
    }
    for (const stage of ['queue', 'scheduler']) for (const pauseFails of [false, true]) {
      // Isolated subprocess: replace credential acquisition and every HTTP call. No real token or cloud access.
      const source = `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        cp.execFileSync = () => 'offline-placeholder';
        syncBuiltinESMExports();
        globalThis.fetch = async (url, options) => {
          if (url.endsWith(':pause') && ${pauseFails}) throw new Error('offline pause denied');
          if (options.method !== 'GET' && !url.endsWith(':pause')) throw new Error('Unexpected mutation');
          const value = url.includes('cloudresourcemanager')
            ? { projectNumber: '${config.projectNumber}', lifecycleState: 'ACTIVE', labels: { 'queuepilot-environment': 'demo' } }
            : { state: '${stage === 'queue' ? 'RUNNING' : 'ENABLED'}' };
          return { status: 200, ok: true, json: async () => value };
        };
        process.argv = ['node', '--config', ${JSON.stringify(path)}, '--stage=${stage}', '--apply', '--approve-project=${config.projectId}'];
        await import('./infra/apply.mjs');
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /offline pause denied|pause not confirmed/);
      assert.doesNotMatch(result.stdout, /NOOP/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Cloud Resource Manager is an explicit bootstrap prerequisite', () => {
  assert.ok(resources.some((r) => r.kind === 'api' && r.path.endsWith('/services/cloudresourcemanager.googleapis.com')));
});
