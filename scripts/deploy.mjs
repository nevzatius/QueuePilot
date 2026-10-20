import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, ScriptError, parseOptions, runCli } from './lib/ops.mjs';
import { formatPlan, loadScope, planDigest } from './lib/cloud-ops.mjs';

// Guarded front end for ONE stage of the staged infrastructure model (infra/spec.mjs -> infra/apply.mjs).
// Dry run (default) prints a readable plan and a digest and makes no network or credential access.
// --apply additionally needs the exact project, region, plan digest and stage-specific approvals, and
// then hands over to infra/apply.mjs, whose own checks (project number, demo label, Firestore location,
// paused queue/scheduler, pinned images) are not bypassed. This script never resumes a queue or job.
//
//   node scripts/deploy.mjs --config C --project P --region europe-west1 --stage queue
//   node scripts/deploy.mjs --config C --project P --region europe-west1 --stage queue \
//        --apply --approve-project P --approve-region europe-west1 --approve-plan DIGEST

const OPTIONS = {
  config: { type: 'string' }, project: { type: 'string' }, region: { type: 'string' }, stage: { type: 'string' },
  apply: { type: 'boolean', default: false }, 'approve-project': { type: 'string' }, 'approve-region': { type: 'string' },
  'approve-plan': { type: 'string' }, 'approve-firestore-location': { type: 'string' },
  'approve-public-api': { type: 'boolean', default: false }, 'approve-b4-worker-image': { type: 'string' },
};

export function parseDeployArgs(argv) {
  const values = parseOptions(argv, OPTIONS);
  if (!values.config) throw new ScriptError(EXIT.USAGE, 'Missing --config (non-secret JSON, see infra/config.example.json)');
  if (!values.stage) throw new ScriptError(EXIT.USAGE, 'Missing --stage (exactly one stage)');
  return values;
}

export function runDeploy(values, deps) {
  const apply = values.apply;
  const requireImages = apply && (values.stage === 'deploy' || Boolean(values['approve-b4-worker-image']));
  const config = loadScope({
    configText: deps.readFile(values.config), project: values.project, region: values.region,
    approveProject: values['approve-project'], approveRegion: values['approve-region'], apply, requireImages,
  });
  const stage = values.stage;
  const digest = planDigest(config, stage);
  const args = ['infra/apply.mjs', '--config', resolve(values.config), '--stage', stage];
  if (apply) args.push('--apply', `--approve-project=${values['approve-project']}`);
  if (apply && stage === 'data') args.push(`--approve-firestore-location=${values['approve-firestore-location'] ?? ''}`);
  if (apply && stage === 'scheduler' && values['approve-b4-worker-image']) args.push(`--approve-b4-worker-image=${values['approve-b4-worker-image']}`);
  for (const line of formatPlan(config, stage, { digest, command: `node ${args.join(' ')}` })) deps.io.out(line);

  if (!apply) {
    deps.io.out('DRY RUN: no credentials, network or cloud resources were used. Nothing was changed.');
    return EXIT.OK;
  }
  if (values['approve-plan'] !== digest) throw new ScriptError(EXIT.REFUSED, 'Writes require --approve-plan=<digest of the reviewed plan above>');
  if (stage === 'data' && values['approve-firestore-location'] !== config.region) {
    throw new ScriptError(EXIT.REFUSED, `The data stage requires --approve-firestore-location=${config.region} (irreversible)`);
  }
  if (stage === 'iam' && !values['approve-public-api']) {
    throw new ScriptError(EXIT.REFUSED, 'The iam stage makes the API publicly invocable; pass --approve-public-api to confirm');
  }
  if (stage === 'scheduler' && values['approve-b4-worker-image'] && values['approve-b4-worker-image'] !== config.workerImage) {
    throw new ScriptError(EXIT.REFUSED, '--approve-b4-worker-image must equal the configured pinned worker image');
  }
  deps.io.out('APPLY: delegating to infra/apply.mjs');
  return deps.runApply(args);
}

const root = fileURLToPath(new URL('..', import.meta.url));
export const productionDeps = (io) => ({
  io,
  readFile: (path) => {
    try { return readFileSync(path, 'utf8'); } catch { throw new ScriptError(EXIT.USAGE, 'Cannot read the configuration file'); }
  },
  // Fixed script path and an argument array: no shell, no interpolation.
  runApply: (args) => spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status ?? EXIT.IO,
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(async (argv, io) => runDeploy(parseDeployArgs(argv), productionDeps(io)), process.argv.slice(2));
}
