import { createHash } from 'node:crypto';
import { EXIT, ScriptError } from './ops.mjs';
import { specification, stages, validateConfig } from '../../infra/spec.mjs';

// Guard rails shared by the deploy and shutdown wrappers. Everything here is pure and offline:
// it validates configuration and approvals and builds readable plans from infra/spec.mjs, the single
// source of truth for resources. Applying is delegated to existing infra code, never reimplemented.

export const SUPPORTED_REGIONS = ['europe-west1']; // irreversible Firestore location, ADR-007

/** Parse the non-secret JSON configuration (the same file infra/apply.mjs takes) and validate scope. */
export function loadScope({ configText, project, region, approveProject, approveRegion, apply, requireImages = false }) {
  if (!project) throw new ScriptError(EXIT.USAGE, 'Missing --project');
  if (!region) throw new ScriptError(EXIT.USAGE, 'Missing --region');
  if (!SUPPORTED_REGIONS.includes(region)) throw new ScriptError(EXIT.REFUSED, `Unsupported region; only ${SUPPORTED_REGIONS.join(', ')} is approved`);
  let config;
  try { config = JSON.parse(configText); } catch { throw new ScriptError(EXIT.USAGE, 'Configuration is not valid JSON'); }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new ScriptError(EXIT.USAGE, 'Configuration must be a JSON object');
  try { validateConfig(config, apply, requireImages); }
  catch (error) { throw new ScriptError(EXIT.USAGE, `Configuration rejected: ${error.message}`); }
  if (config.projectId !== project) throw new ScriptError(EXIT.REFUSED, '--project does not match the configuration projectId; refusing');
  if (config.region !== region) throw new ScriptError(EXIT.REFUSED, '--region does not match the configuration region; refusing');
  if (apply) {
    if (approveProject !== project) throw new ScriptError(EXIT.REFUSED, 'Writes require --approve-project=<project> (exact match)');
    if (approveRegion !== region) throw new ScriptError(EXIT.REFUSED, 'Writes require --approve-region=<region> (exact match)');
  } else if ((approveProject !== undefined && approveProject !== project) || (approveRegion !== undefined && approveRegion !== region)) {
    throw new ScriptError(EXIT.REFUSED, 'An approval argument does not match; refusing even in dry run');
  }
  return config;
}

export const planResources = (config, stage) => {
  if (stage === 'all' || !stages.includes(stage)) throw new ScriptError(EXIT.USAGE, `--stage must be exactly one of: ${stages.join(', ')}`);
  return specification(config).filter((resource) => resource.stage === stage);
};

/** Short, stable fingerprint of what a stage would manage. The owner repeats it to apply what was reviewed. */
export const planDigest = (config, stage, extra = []) =>
  createHash('sha256').update(JSON.stringify([stage, planResources(config, stage), extra])).digest('hex').slice(0, 12);

export const STAGE_WARNINGS = {
  bootstrap: ['Enables 10 Google APIs and creates service accounts, custom roles, the redis-url secret metadata (no version) and the Artifact Registry repository.'],
  data: ['Creates the (default) Firestore database in the approved region if absent. THE LOCATION CANNOT BE CHANGED AFTERWARDS (ADR-007).',
    'Installs deny-all security rules, indexes and TTL policies. No application data is written.'],
  queue: ['Creates Cloud Tasks queue qp-process and PAUSES it. Nothing resumes it: activation is a separate owner action after the cloud checks.'],
  access: ['Grants least-privilege IAM (see infra/README.md IAM table). No runtime account receives broad roles.'],
  deploy: ['Deploys the private worker, then the API, from the pinned image digests in the configuration. Scale-to-zero, max instances as in infra/spec.mjs.'],
  iam: ['EXPOSES THE API PUBLICLY: grants allUsers roles/run.invoker on qp-api. Requires --approve-public-api. The worker stays private.'],
  scheduler: ['Creates Cloud Scheduler job qp-reconcile only with --approve-b4-worker-image, and always PAUSED. Without it the job is DEFERRED, not created.'],
};

export function formatPlan(config, stage, { digest, command }) {
  const lines = [`Plan for stage "${stage}" in project ${config.projectId}, region ${config.region}:`];
  for (const resource of planResources(config, stage)) {
    lines.push(`  - ${resource.stage}/${resource.id} [${resource.kind ?? resource.host}] ${resource.host}:${resource.path}`);
  }
  for (const warning of STAGE_WARNINGS[stage] ?? []) lines.push(`  ! ${warning}`);
  lines.push(`Plan digest: ${digest}`);
  lines.push(`Delegates to (existing safety checks stay in force): ${command}`);
  return lines;
}
