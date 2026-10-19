import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { accessToken, cloudClient, reconcile } from './cloud.mjs';
import { specification, stages, validateConfig } from './spec.mjs';

const { values } = parseArgs({ options: {
  config: { type: 'string', default: 'infra/config.example.json' },
  stage: { type: 'string', default: 'all' },
  apply: { type: 'boolean', default: false },
  'approve-project': { type: 'string' },
  'approve-firestore-location': { type: 'string' },
  'approve-b4-worker-image': { type: 'string' },
} });
try {
  const config = JSON.parse(readFileSync(values.config, 'utf8'));
  validateConfig(config, values.apply, values.apply && (values.stage === 'deploy' || Boolean(values['approve-b4-worker-image'])));
  if (values.stage !== 'all' && !stages.includes(values.stage)) throw new Error('Unknown stage');
  const resources = specification(config).filter((r) => values.stage === 'all' || r.stage === values.stage);
  if (!values.apply) {
    console.log(JSON.stringify({ mode: 'OFFLINE PLAN: no credentials or network used', resources }, null, 2));
  } else {
    if (values['approve-project'] !== config.projectId || values.stage === 'all') {
      throw new Error('Apply requires --approve-project=<demo-project> and one explicit --stage');
    }
    // Check irreversible-location consent before reading any credentials or making any cloud calls.
    if (values.stage === 'data' && values['approve-firestore-location'] !== config.region) {
      throw new Error('Data apply requires --approve-firestore-location=europe-west1 and exact --approve-project');
    }
    if (values['approve-b4-worker-image'] && values['approve-b4-worker-image'] !== config.workerImage) {
      throw new Error('B4 deployment approval must match the configured pinned worker image');
    }
    const client = cloudClient(accessToken());
    const project = await client('cloudresourcemanager', `v1/projects/${config.projectId}`);
    if (project.projectNumber !== config.projectNumber || project.lifecycleState !== 'ACTIVE') throw new Error('Project identity mismatch');
    if (project.labels?.['queuepilot-environment'] !== 'demo') throw new Error('Owner must label this project queuepilot-environment=demo');
    // Secret access is checked through metadata only; secret payloads are never read by this script.
    if (values.stage === 'deploy') {
      const version = await client('secretmanager', `v1/projects/${config.projectId}/secrets/redis-url/versions/${config.redisSecretVersion}`);
      if (version.state !== 'ENABLED') throw new Error('Pinned Redis secret version must be enabled');
    }
    for (const resource of resources) console.log(`${resource.stage}/${resource.id}: ${await reconcile(client, resource, {
      projectId: values['approve-project'], firestoreLocation: values['approve-firestore-location'],
      schedulerImage: values['approve-b4-worker-image'],
    })}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Infrastructure command failed');
  process.exitCode = 1;
}
