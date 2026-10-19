/* global structuredClone */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { accessToken, cloudClient, reconcile } from '../../infra/cloud.mjs';
import { specification, validateConfig } from '../../infra/spec.mjs';

export function spikeSpecification(config) {
  const resources = specification(config);
  const project = `projects/${config.projectId}`;
  const location = `${project}/locations/${config.region}`;
  const email = (id) => `${id}@${config.projectId}.iam.gserviceaccount.com`;
  const origin = `https://qp-spike-worker-${config.projectNumber}.${config.region}.run.app`;
  const result = ['qp-spike-reader', 'qp-spike-no-get', 'qp-spike-invoker', 'qp-spike-scheduler', 'qp-spike-hosting-sa'].map((id) => ({
    stage: 'identities', id, host: 'iam', kind: 'createOnly', path: `v1/${project}/serviceAccounts/${email(id)}`,
    parent: `v1/${project}/serviceAccounts`, body: { accountId: id, serviceAccount: { displayName: id } },
  }));
  for (const id of ['qp-spike-semantics', 'qp-spike-retry', 'qp-spike-slow']) {
    const queue = structuredClone(resources.find((r) => r.id === 'qp-process' && r.stage === 'queue'));
    Object.assign(queue, { stage: 'queues', id, path: `v2/${location}/queues/${id}` });
    queue.body = { name: `${location}/queues/${id}`, rateLimits: { maxDispatchesPerSecond: 1, maxConcurrentDispatches: 1 },
      retryConfig: { maxAttempts: 3, maxRetryDuration: '120s', minBackoff: '2s', maxBackoff: '10s', maxDoublings: 2 } };
    if (id === 'qp-spike-slow') Object.assign(queue.body.retryConfig, { minBackoff: '130s', maxBackoff: '130s', maxDoublings: 0 });
    result.push(queue);
    for (const [identity, role] of [['qp-spike-reader', 'qpReconciler'], ['qp-spike-no-get', 'qpEnqueuer']]) {
      result.push({ stage: 'access', id: `${id}-${identity}`, host: 'cloudtasks', kind: 'iam', path: queue.path,
        body: { role: `${project}/roles/${role}`, members: [`serviceAccount:${email(identity)}`] } });
    }
  }
  const worker = structuredClone(resources.find((r) => r.id === 'qp-worker' && r.stage === 'deploy'));
  Object.assign(worker, { id: 'qp-spike-worker', path: `v2/${location}/services/qp-spike-worker`,
    parent: `v2/${location}/services?serviceId=qp-spike-worker` });
  worker.body.template.serviceAccount = email('qp-spike-reader');
  worker.body.template.scaling.maxInstanceCount = 1;
  worker.body.scaling.maxInstanceCount = 1;
  worker.body.template.maxInstanceRequestConcurrency = 1;
  worker.body.template.containers[0].env = [
    { name: 'QP_ENV', value: 'spike' }, { name: 'QP_REGION', value: config.region },
    { name: 'REDIS_URL', valueSource: { secretKeyRef: { secret: 'redis-url', version: config.redisSecretVersion } } },
  ];
  result.push(worker);
  const hosting = structuredClone(worker);
  Object.assign(hosting, { id: 'qp-spike-hosting', path: `v2/${location}/services/qp-spike-hosting`,
    parent: `v2/${location}/services?serviceId=qp-spike-hosting` });
  hosting.body.template.serviceAccount = email('qp-spike-hosting-sa');
  hosting.body.template.containers[0].env = hosting.body.template.containers[0].env.filter((e) => e.name !== 'REDIS_URL');
  result.push(hosting);
  for (const identity of ['qp-spike-reader', 'qp-spike-no-get']) {
    result.push({ stage: 'access', id: `${identity}-actas`, host: 'iam', kind: 'iam',
      path: `v1/${project}/serviceAccounts/${email('qp-spike-invoker')}`,
      body: { role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:${email(identity)}`] } });
  }
  result.push({ stage: 'access', id: 'spike-agent-actas', host: 'iam', kind: 'iam',
    path: `v1/${project}/serviceAccounts/${email('qp-spike-invoker')}`,
    body: { role: 'roles/iam.serviceAccountUser', members: [`serviceAccount:service-${config.projectNumber}@gcp-sa-cloudtasks.iam.gserviceaccount.com`] } });
  result.push({ stage: 'access', id: 'probe-redis', host: 'secretmanager', kind: 'iam', path: `v1/${project}/secrets/redis-url`,
    body: { role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${email('qp-spike-reader')}`] } });
  result.push({ stage: 'iam', id: 'worker-private', host: 'run', kind: 'iam', path: worker.path,
    body: { role: 'roles/run.invoker', members: ['qp-spike-invoker', 'qp-spike-scheduler'].map((id) => `serviceAccount:${email(id)}`) } });
  result.push({ stage: 'iam', id: 'spike-hosting-public', host: 'run', kind: 'iam', path: hosting.path,
    body: { role: 'roles/run.invoker', members: ['allUsers'] } });
  const scheduler = structuredClone(resources.find((r) => r.stage === 'scheduler'));
  Object.assign(scheduler, { id: 'qp-spike-scheduler', path: `v1/${location}/jobs/qp-spike-scheduler`, targetService: worker.path });
  scheduler.body.name = `${location}/jobs/qp-spike-scheduler`;
  scheduler.body.httpTarget.uri = `${origin}/probe/success/spike-scheduler`;
  scheduler.body.httpTarget.oidcToken = { serviceAccountEmail: email('qp-spike-scheduler'), audience: origin };
  result.push(scheduler);
  return result;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/spike/setup.mjs')) {
  try {
    const { values } = parseArgs({ options: {
      config: { type: 'string', default: 'infra/config.example.json' }, stage: { type: 'string', default: 'all' },
      apply: { type: 'boolean', default: false }, 'approve-project': { type: 'string' },
      'approve-spike-worker-image': { type: 'string' },
    } });
    const config = JSON.parse(readFileSync(values.config, 'utf8'));
    validateConfig(config, values.apply, values.apply && (values.stage === 'deploy' || Boolean(values['approve-spike-worker-image'])));
    const allowed = ['identities', 'queues', 'access', 'deploy', 'iam', 'scheduler'];
    if (values.stage !== 'all' && !allowed.includes(values.stage)) throw new Error('Unknown spike stage');
    const resources = spikeSpecification(config).filter((r) => values.stage === 'all' || r.stage === values.stage);
    if (!values.apply) console.log(JSON.stringify({ mode: 'OFFLINE PLAN', resources }, null, 2));
    else {
      if (values.stage === 'all' || values['approve-project'] !== config.projectId) throw new Error('One stage and explicit demo project approval are required');
      if (values['approve-spike-worker-image'] && values['approve-spike-worker-image'] !== config.workerImage) {
        throw new Error('Spike deployment approval must match the configured pinned worker image');
      }
      const client = cloudClient(accessToken());
      const project = await client('cloudresourcemanager', `v1/projects/${config.projectId}`);
      if (project.projectNumber !== config.projectNumber || project.lifecycleState !== 'ACTIVE'
        || project.labels?.['queuepilot-environment'] !== 'demo') throw new Error('Demo project identity mismatch');
      for (const resource of resources) console.log(`${resource.stage}/${resource.id}: ${await reconcile(client, resource, {
        schedulerImage: values['approve-spike-worker-image'],
      })}`);
    }
  } catch (error) { console.error(error instanceof Error ? error.message : 'Setup failed'); process.exitCode = 1; }
}
