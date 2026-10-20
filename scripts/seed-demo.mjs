import { pathToFileURL } from 'node:url';
import { accessToken, cloudClient } from '../infra/cloud.mjs';
import { EXIT, FirestoreRest, ScriptError, parseOptions, resolveTarget, runCli, verifyCloudProject } from './lib/ops.mjs';

// Demo data seed: creates only the `sandbox` tenant that POST /api/v1/session/bootstrap requires
// (ARCHITECTURE §5, §15). It never creates memberships or admins: members come from the API's bootstrap,
// the admin from scripts/grant-role.mjs.
//
//   node scripts/seed-demo.mjs --project P --open-signup true|false                  (dry run)
//   node scripts/seed-demo.mjs --project P --open-signup false --apply --approve-project P [--project-number N, required for a real project]
//
// Identifiers are fixed and documented: tenant `sandbox`. Create-only: an existing document is
// compared and never overwritten, so reruns are idempotent and drift is reported, not "fixed".

export const SANDBOX_ID = 'sandbox';
// ARCHITECTURE §15 defaults: 10/min/user, 30/day/user, 2000/day for the sandbox tenant.
export const sandboxTenant = (openSignup) => ({
  name: 'Sandbox', status: 'active', openSignup, quotaMode: 'enforced', schemaVersion: 1,
  limits: { submitPerMin: 10, submitPerDayUser: 30, submitPerDayTenant: 2000 },
});

const OPTIONS = {
  project: { type: 'string' }, 'project-number': { type: 'string' }, 'approve-project': { type: 'string' }, 'open-signup': { type: 'string' },
  apply: { type: 'boolean', default: false },
};

export function parseSeedArgs(argv, env) {
  const values = parseOptions(argv, OPTIONS);
  if (!['true', 'false'].includes(values['open-signup'] ?? '')) {
    throw new ScriptError(EXIT.USAGE, 'Pass --open-signup true|false explicitly: it decides whether anyone with a Google login can join the sandbox');
  }
  const target = resolveTarget({ project: values.project, approveProject: values['approve-project'], apply: values.apply, env });
  if (values['project-number'] !== undefined && !/^[1-9][0-9]{5,19}$/.test(values['project-number'])) throw new ScriptError(EXIT.USAGE, 'Invalid --project-number');
  if (target.mode === 'cloud' && values.apply && values['project-number'] === undefined) {
    throw new ScriptError(EXIT.REFUSED, 'Cloud writes require --project-number=<number> (pinned like infra/apply.mjs)');
  }
  return { target, openSignup: values['open-signup'] === 'true', apply: values.apply, projectNumber: values['project-number'] };
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** Top-level field names whose values differ (names only; values may be edited by the owner and are not echoed). */
export const driftFields = (actual, wanted) => [...new Set([...Object.keys(actual ?? {}), ...Object.keys(wanted)])]
  .filter((key) => !same(actual?.[key], wanted[key])).sort();
const canonical = (value) => value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export async function seedDemo(options, deps) {
  const { target, openSignup, apply, projectNumber } = options;
  const tenant = sandboxTenant(openSignup);
  deps.io.out(`${apply ? 'APPLY' : 'DRY RUN'}: project=${target.project} (${target.mode})`);
  deps.io.out(`  tenants/${SANDBOX_ID}: ${JSON.stringify(tenant)}`);
  if (!apply) {
    deps.io.out('Nothing was read or written. Writes need --apply and --approve-project=<project>.');
    return EXIT.OK;
  }
  await verifyCloudProject(target, { client: (...args) => deps.cloudClient()(...args) }, projectNumber);
  const store = deps.firestore(target);

  const created = await store.create('tenants', SANDBOX_ID, tenant);
  if (created) { deps.io.out('tenants/sandbox: created'); return EXIT.OK; }
  const existing = await store.get(`tenants/${SANDBOX_ID}`);
  if (!existing) throw new ScriptError(EXIT.STATE, 'tenants/sandbox was reported as existing but cannot be read; rerun to re-evaluate');
  const differing = driftFields(existing.data, tenant);
  if (differing.length) {
    deps.io.err(`DRIFT tenants/sandbox: fields differ from the seed: ${differing.join(', ')}. Not overwriting; inspect it and change it deliberately.`);
    return EXIT.STATE;
  }
  deps.io.out('tenants/sandbox: unchanged');
  return EXIT.OK;
}

const token = () => {
  try { return accessToken(); }
  catch { throw new ScriptError(EXIT.IO, 'No gcloud access token; run `gcloud auth login` as the owner'); }
};
export const productionDeps = (io) => ({
  io, now: Date.now,
  cloudClient: () => cloudClient(token()),
  firestore: (target) => new FirestoreRest({ target, token: async () => token() }),
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(async (argv, io) => seedDemo(parseSeedArgs(argv, process.env), productionDeps(io)), process.argv.slice(2));
}
