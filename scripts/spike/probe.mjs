import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { accessToken, cloudClient, CloudError } from '../../infra/cloud.mjs';
import { validateConfig } from '../../infra/spec.mjs';

// This is a probe classification only. B4 must test the production adapter independently.
export function classifyTaskError(error) {
  return error instanceof CloudError && error.status === 404 && error.code === 'NOT_FOUND' ? 'ABSENT' : 'PROBE_UNKNOWN';
}

export async function probe(values) {
  const config = JSON.parse(readFileSync(values.config, 'utf8'));
  validateConfig(config);
  if (!/^qp-spike-[a-z0-9-]{1,40}$/.test(values.queue)) throw new Error('Only isolated qp-spike-* queues are allowed');
  if (!/^qp-spike-[a-z0-9-]{1,20}$/.test(values.identity)) throw new Error('Only isolated probe service accounts are allowed');
  if (!['create', 'get', 'delete'].includes(values.action)) throw new Error('Unknown probe action');
  if (!['success', '409', '429', 'fail', 'delay'].includes(values.case)) throw new Error('Unknown handler case');
  if (values.task && !/^spike-[a-z0-9-]{1,100}$/.test(values.task)) throw new Error('Only isolated spike-* task names are allowed');
  if (values.action !== 'create' && !values.task) throw new Error('--task is required');
  const parent = `projects/${config.projectId}/locations/${config.region}/queues/${values.queue}`;
  const taskId = values.task ?? `spike-${randomUUID()}`;
  const name = `${parent}/tasks/${taskId}`;
  const origin = `https://qp-spike-worker-${config.projectNumber}.${config.region}.run.app`;
  const task = { name, dispatchDeadline: '30s', httpRequest: {
    url: `${origin}/probe/${values.case}/${taskId}`, httpMethod: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ runId: taskId })).toString('base64'),
    oidcToken: { serviceAccountEmail: `qp-spike-invoker@${config.projectId}.iam.gserviceaccount.com`, audience: origin },
  } };
  if (!values.run) return { mode: 'OFFLINE PLAN', action: values.action, identity: values.identity, task };
  validateConfig(config, true);
  if (values['approve-project'] !== config.projectId) throw new Error('Explicit demo project approval is required');
  let client = cloudClient(accessToken());
  const project = await client('cloudresourcemanager', `v1/projects/${config.projectId}`);
  if (project.projectNumber !== config.projectNumber || project.lifecycleState !== 'ACTIVE'
    || project.labels?.['queuepilot-environment'] !== 'demo') throw new Error('Demo project identity mismatch');
  // Owner needs token-creator on these probe identities only, never keys.
  const impersonated = await client('iamcredentials',
    `v1/projects/-/serviceAccounts/${values.identity}@${config.projectId}.iam.gserviceaccount.com:generateAccessToken`,
    'POST', { scope: ['https://www.googleapis.com/auth/cloud-platform'], lifetime: '600s' });
  client = cloudClient(impersonated.accessToken);
  const startedAt = new Date().toISOString();
  try {
    const result = values.action === 'create'
      ? await client('cloudtasks', `v2/${parent}/tasks`, 'POST', { task })
      : await client('cloudtasks', `v2/${name}`, values.action === 'delete' ? 'DELETE' : 'GET');
    return { startedAt, action: values.action, task: name, identity: values.identity, outcome: 'OK',
      createTime: result.createTime, dispatchCount: result.dispatchCount, responseCount: result.responseCount,
      firstAttempt: result.firstAttempt, lastAttempt: result.lastAttempt };
  } catch (error) {
    if (!(error instanceof CloudError)) throw error;
    return { startedAt, action: values.action, task: name, identity: values.identity,
      outcome: error.code, httpStatus: error.status,
      ...(values.action === 'get' ? { probeClassification: classifyTaskError(error) } : {}) };
  }
}

// Importing this module in offline tests must never read credentials or contact GCP.
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/spike/probe.mjs')) {
  try {
    const { values } = parseArgs({ options: {
      config: { type: 'string', default: 'infra/config.example.json' },
      queue: { type: 'string', default: 'qp-spike-semantics' },
      identity: { type: 'string', default: 'qp-spike-reader' },
      action: { type: 'string', default: 'create' }, case: { type: 'string', default: 'success' },
      task: { type: 'string' }, run: { type: 'boolean', default: false }, 'approve-project': { type: 'string' },
    } });
    console.log(JSON.stringify(await probe(values), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Probe failed');
    process.exitCode = 1;
  }
}
