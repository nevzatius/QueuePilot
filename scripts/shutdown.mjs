import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { accessToken, cloudClient, ensurePaused, getOrAbsent } from '../infra/cloud.mjs';
import { specification } from '../infra/spec.mjs';
import { EXIT, ScriptError, parseOptions, runCli } from './lib/ops.mjs';
import { loadScope } from './lib/cloud-ops.mjs';

// Ordinary shutdown = stop new background work, nothing more. Pauses the reconcile Scheduler job
// and the qp-process Cloud Tasks queue (reusing infra/cloud.mjs ensurePaused, which re-reads and
// requires state PAUSED). It deletes nothing: not the Firestore database, data, secrets, images,
// services or the Hosting site. Dry run is the default and uses no credentials or network.
//
//   node scripts/shutdown.mjs --config C --project P --region europe-west1
//   node scripts/shutdown.mjs --config C --project P --region europe-west1 --apply --approve-project P --approve-region europe-west1

const OPTIONS = {
  config: { type: 'string' }, project: { type: 'string' }, region: { type: 'string' },
  apply: { type: 'boolean', default: false }, 'approve-project': { type: 'string' }, 'approve-region': { type: 'string' },
};

export function parseShutdownArgs(argv) {
  const values = parseOptions(argv, OPTIONS);
  if (!values.config) throw new ScriptError(EXIT.USAGE, 'Missing --config');
  return values;
}

/** The only resources this wrapper may touch, taken from the single specification. */
export function shutdownTargets(config) {
  const wanted = new Set(['qp-reconcile', 'qp-process']);
  const targets = specification(config).filter((r) => wanted.has(r.id) && ['cloudscheduler', 'cloudtasks'].includes(r.host));
  if (targets.length !== wanted.size) throw new ScriptError(EXIT.STATE, 'Specification does not define the expected queue and scheduler job');
  return targets.sort((a, b) => (a.host === 'cloudscheduler' ? -1 : 1) - (b.host === 'cloudscheduler' ? -1 : 1)); // stop the producer first
}

export const NOT_DONE = [
  'Cloud Run services are NOT deleted or changed. They already scale to zero (min instances 0), but idle services, Artifact Registry images,',
  'Secret Manager, Firestore storage and operations, Hosting, logs and any Upstash database can still incur cost. Scale-to-zero is not zero cost.',
  'In-flight Cloud Tasks deliveries are not cancelled by a pause; queued tasks stay queued until the owner resumes the queue.',
  'The Firestore database and all data are kept (delete protection stays on). Deleting anything is a separate, explicit owner operation.',
];

export async function runShutdown(values, deps) {
  const apply = values.apply;
  const config = loadScope({
    configText: deps.readFile(values.config), project: values.project, region: values.region,
    approveProject: values['approve-project'], approveRegion: values['approve-region'], apply,
  });
  const targets = shutdownTargets(config);
  deps.io.out(`${apply ? 'APPLY' : 'DRY RUN'}: shutdown of project ${config.projectId}, region ${config.region}`);
  for (const target of targets) deps.io.out(`  - pause ${target.host === 'cloudscheduler' ? 'Scheduler job' : 'Cloud Tasks queue'} ${target.id} (${target.path})`);
  for (const line of NOT_DONE) deps.io.out(`  ! ${line}`);
  if (!apply) {
    deps.io.out('Nothing was read or changed. Writes need --apply, --approve-project and --approve-region.');
    return EXIT.OK;
  }
  const client = deps.client();
  const project = await client('cloudresourcemanager', `v1/projects/${config.projectId}`);
  if (project.projectNumber !== config.projectNumber || project.lifecycleState !== 'ACTIVE') throw new ScriptError(EXIT.REFUSED, 'Project identity mismatch; refusing');
  if (project.labels?.['queuepilot-environment'] !== 'demo') throw new ScriptError(EXIT.REFUSED, 'Project is not labelled queuepilot-environment=demo; refusing');
  for (const target of targets) {
    const current = await getOrAbsent(client, target.host, target.path);
    if (!current) { deps.io.out(`${target.id}: absent, nothing to pause`); continue; }
    const wasPaused = current.state === 'PAUSED';
    await ensurePaused(client, target, current); // throws unless the re-read confirms PAUSED
    deps.io.out(`${target.id}: ${wasPaused ? 'already paused' : 'paused'} (state=PAUSED confirmed)`);
  }
  return EXIT.OK;
}

const token = () => {
  try { return accessToken(); }
  catch { throw new ScriptError(EXIT.IO, 'No gcloud access token; run `gcloud auth login` as the owner'); }
};
export const productionDeps = (io) => ({
  io,
  readFile: (path) => {
    try { return readFileSync(path, 'utf8'); } catch { throw new ScriptError(EXIT.USAGE, 'Cannot read the configuration file'); }
  },
  client: () => cloudClient(token()),
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(async (argv, io) => runShutdown(parseShutdownArgs(argv), productionDeps(io)), process.argv.slice(2));
}
