import { readFileSync } from 'node:fs';

export const readJson = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
export const indexes = readJson('./firestore.indexes.json');
export const rules = readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');
export const stages = ['bootstrap', 'data', 'queue', 'access', 'deploy', 'iam', 'scheduler'];
export const queueConfig = {
  rateLimits: { maxDispatchesPerSecond: 20, maxConcurrentDispatches: 30 },
  retryConfig: { maxAttempts: 10, maxRetryDuration: '600s', minBackoff: '2s', maxBackoff: '60s', maxDoublings: 4 },
};

export function validateConfig(c, applying = false, requireImages = false) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(c.projectId)) throw new Error('Invalid project ID');
  if (!/^[1-9][0-9]{5,19}$/.test(c.projectNumber)) throw new Error('Invalid project number');
  if (c.environment !== 'demo' || c.region !== 'europe-west1') throw new Error('Only the approved demo region is supported');
  if (!/^[1-9][0-9]*$/.test(c.redisSecretVersion)) throw new Error('Pin a numeric Redis secret version');
  if (applying && (c.projectId.startsWith('replace-') || /(^|[-_])(prod|production)([-_]|$)/i.test(c.projectId))) {
    throw new Error('Refusing a placeholder or production project');
  }
  for (const key of ['apiImage', 'workerImage']) {
    if (requireImages && !new RegExp(`^europe-west1-docker\\.pkg\\.dev/${c.projectId}/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$`).test(c[key])) {
      throw new Error(`${key} must be an immutable image in this demo project`);
    }
  }
  const allowed = ['projectId', 'projectNumber', 'environment', 'region', 'apiImage', 'workerImage', 'redisSecretVersion'];
  if (Object.keys(c).some((key) => !allowed.includes(key))) throw new Error('Unknown configuration key; credentials and fault flags are forbidden');
}

export function specification(c) {
  validateConfig(c);
  const p = `projects/${c.projectId}`;
  const location = `${p}/locations/${c.region}`;
  const sa = (name) => `${name}@${c.projectId}.iam.gserviceaccount.com`;
  const workerUrl = `https://qp-worker-${c.projectNumber}.${c.region}.run.app`;
  const resources = [];
  const add = (stage, id, host, path, parent, body, options = {}) => resources.push({ stage, id, host, path, parent, body, ...options });
  for (const api of ['run', 'cloudtasks', 'cloudscheduler', 'firestore', 'firebaserules', 'secretmanager', 'iam', 'iamcredentials', 'artifactregistry']) {
    add('bootstrap', api, 'serviceusage', `v1/projects/${c.projectNumber}/services/${api}.googleapis.com`, null, {}, { kind: 'api' });
  }
  for (const api of ['cloudtasks', 'cloudscheduler']) {
    add('bootstrap', `${api}-agent`, 'serviceusage', `v1beta1/projects/${c.projectNumber}/services/${api}.googleapis.com:generateServiceIdentity`, null, {}, { kind: 'identity' });
  }
  for (const accountId of ['qp-api-sa', 'qp-worker-sa', 'qp-tasks-invoker-sa', 'qp-scheduler-sa']) {
    add('bootstrap', accountId, 'iam', `v1/${p}/serviceAccounts/${sa(accountId)}`, `v1/${p}/serviceAccounts`,
      { accountId, serviceAccount: { displayName: accountId } }, { kind: 'createOnly' });
  }
  add('bootstrap', 'redis-url', 'secretmanager', `v1/${p}/secrets/redis-url`, `v1/${p}/secrets?secretId=redis-url`,
    { replication: { automatic: {} } }, { kind: 'createOnly' });
  add('bootstrap', 'queuepilot-images', 'artifactregistry', `v1/${location}/repositories/queuepilot`,
    `v1/${location}/repositories?repositoryId=queuepilot`, { format: 'DOCKER', description: 'QueuePilot immutable deployment images' }, { kind: 'createOnly' });
  for (const [roleId, permissions] of [
    ['qpEnqueuer', ['cloudtasks.tasks.create']],
    ['qpReconciler', ['cloudtasks.tasks.create', 'cloudtasks.tasks.get']],
  ]) {
    add('bootstrap', roleId, 'iam', `v1/${p}/roles/${roleId}`, `v1/${p}/roles`,
      { title: roleId, description: 'QueuePilot runtime queue permissions', stage: 'GA', includedPermissions: permissions },
      { createBody: { roleId }, kind: 'role' });
  }
  add('data', 'database', 'firestore', `v1/${p}/databases/(default)`, `v1/${p}/databases?databaseId=(default)`,
    { locationId: c.region, type: 'FIRESTORE_NATIVE', deleteProtectionState: 'DELETE_PROTECTION_ENABLED' }, { kind: 'database' });
  add('data', 'rules', 'firebaserules', `v1/${p}/releases/cloud.firestore`, `v1/${p}/rulesets`,
    { source: { files: [{ name: 'firestore.rules', content: rules }] } }, { kind: 'rules' });
  for (const index of indexes.indexes) {
    const parent = `v1/${p}/databases/(default)/collectionGroups/${index.collectionGroup}/indexes`;
    add('data', `index-${resources.length}`, 'firestore', parent, parent,
      { queryScope: index.queryScope, fields: index.fields }, { kind: 'index' });
  }
  for (const field of indexes.fieldOverrides) {
    const body = { indexConfig: { indexes: field.indexes } };
    if (field.ttl) body.ttlConfig = {};
    add('data', `${field.collectionGroup}.${field.fieldPath}`, 'firestore',
      `v1/${p}/databases/(default)/collectionGroups/${field.collectionGroup}/fields/${field.fieldPath}`, null, body, { kind: 'field' });
  }
  add('queue', 'qp-process', 'cloudtasks', `v2/${location}/queues/qp-process`, `v2/${location}/queues`,
    { name: `${location}/queues/qp-process`, ...queueConfig });
  const env = {
    QP_ENV: 'production', GCLOUD_PROJECT: c.projectId, QP_REGION: c.region,
    QP_TASKS_QUEUE: 'qp-process', QP_TASKS_INVOKER_SA: sa('qp-tasks-invoker-sa'),
    QP_WORKER_URL: workerUrl, QP_TASKS_OIDC_AUDIENCE: workerUrl, QP_TASK_DISPATCH_DEADLINE_SECONDS: '30',
    QP_INGEST_RPS_PER_INSTANCE: '40', QP_INGEST_MAX_INFLIGHT: '32', QP_MAX_BACKLOG: '20000',
    QP_MEMBERSHIP_CACHE_TTL: '30', QP_REDIS_ENABLED: 'true', QP_QUOTA_FAILURE_MODE: 'closed',
    QP_RECONCILER_SHARDS: '4', QP_RECONCILE_LIMIT_PER_SHARD: '25',
  };
  for (const [name, max, concurrency, timeout, image] of [
    ['qp-worker', 3, 10, '60s', c.workerImage], ['qp-api', 5, 80, '15s', c.apiImage],
  ]) {
    add('deploy', name, 'run', `v2/${location}/services/${name}`, `v2/${location}/services?serviceId=${name}`,
      { ingress: 'INGRESS_TRAFFIC_ALL', invokerIamDisabled: false, defaultUriDisabled: false,
        scaling: { minInstanceCount: 0, maxInstanceCount: max }, template: {
        serviceAccount: sa(`${name}-sa`), scaling: { minInstanceCount: 0, maxInstanceCount: max },
        maxInstanceRequestConcurrency: concurrency, timeout,
        containers: [{ image, ports: [{ containerPort: 8080 }], resources: { limits: { cpu: '1', memory: '512Mi' }, cpuIdle: true },
          env: [...Object.entries(env).map(([name, value]) => ({ name, value })),
            { name: 'REDIS_URL', valueSource: { secretKeyRef: { secret: 'redis-url', version: c.redisSecretVersion } } }],
        }],
      } });
  }
  const grant = (id, host, path, role, members, project = false) => add(host === 'run' ? 'iam' : 'access', id, host, path, null,
    { role, members }, { kind: 'iam', project });
  for (const name of ['qp-api-sa', 'qp-worker-sa']) {
    grant(`${name}-data`, 'cloudresourcemanager', `v1/${p}`, 'roles/datastore.user', [`serviceAccount:${sa(name)}`], true);
    grant(`${name}-actas`, 'iam', `v1/${p}/serviceAccounts/${sa('qp-tasks-invoker-sa')}`, 'roles/iam.serviceAccountUser', [`serviceAccount:${sa(name)}`]);
    grant(`${name}-redis`, 'secretmanager', `v1/${p}/secrets/redis-url`, 'roles/secretmanager.secretAccessor', [`serviceAccount:${sa(name)}`]);
    grant(`${name}-queue`, 'cloudtasks', `v2/${location}/queues/qp-process`, `${p}/roles/${name === 'qp-api-sa' ? 'qpEnqueuer' : 'qpReconciler'}`, [`serviceAccount:${sa(name)}`]);
  }
  // Platform agents mint tokens; runtime identities receive no token-creator or administration roles.
  for (const [service, suffix, role] of [
    ['tasks', 'gcp-sa-cloudtasks', 'roles/cloudtasks.serviceAgent'],
    ['scheduler', 'gcp-sa-cloudscheduler', 'roles/cloudscheduler.serviceAgent'],
  ]) {
    grant(`${service}-agent`, 'cloudresourcemanager', `v1/${p}`, role,
      [`serviceAccount:service-${c.projectNumber}@${suffix}.iam.gserviceaccount.com`], true);
  }
  grant('tasks-agent-actas', 'iam', `v1/${p}/serviceAccounts/${sa('qp-tasks-invoker-sa')}`,
    'roles/iam.serviceAccountUser', [`serviceAccount:service-${c.projectNumber}@gcp-sa-cloudtasks.iam.gserviceaccount.com`]);
  grant('worker-private', 'run', `v2/${location}/services/qp-worker`, 'roles/run.invoker',
    [`serviceAccount:${sa('qp-tasks-invoker-sa')}`, `serviceAccount:${sa('qp-scheduler-sa')}`]);
  grant('api-public', 'run', `v2/${location}/services/qp-api`, 'roles/run.invoker', ['allUsers']);
  add('scheduler', 'qp-reconcile', 'cloudscheduler', `v1/${location}/jobs/qp-reconcile`, `v1/${location}/jobs`, {
    name: `${location}/jobs/qp-reconcile`, schedule: '* * * * *', timeZone: 'Etc/UTC', attemptDeadline: '60s',
    retryConfig: { retryCount: 0, maxRetryDuration: '0s', minBackoffDuration: '5s', maxBackoffDuration: '60s', maxDoublings: 3 },
    httpTarget: { uri: `${workerUrl}/internal/reconcile`, httpMethod: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: 'e30=',
      oidcToken: { serviceAccountEmail: sa('qp-scheduler-sa'), audience: workerUrl } },
  });
  return resources;
}
