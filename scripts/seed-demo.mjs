import { pathToFileURL } from 'node:url';
import { accessToken, cloudClient } from '../infra/cloud.mjs';
import { EXIT, FirestoreRest, ScriptError, UID, parseOptions, resolveTarget, runCli, verifyCloudProject } from './lib/ops.mjs';

// Demo data seed: creates the `sandbox` tenant that POST /api/v1/session/bootstrap requires
// (membership creation itself stays the API's bootstrap job) and, optionally, one *member*
// membership for a named user. It never creates an admin: use scripts/grant-role.mjs for that.
//
//   node scripts/seed-demo.mjs --project P --open-signup true|false                  (dry run)
//   node scripts/seed-demo.mjs --project P --open-signup false --apply --approve-project P [--member-uid UID]
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
  'member-uid': { type: 'string' }, apply: { type: 'boolean', default: false },
};

export function parseSeedArgs(argv, env) {
  const values = parseOptions(argv, OPTIONS);
  if (!['true', 'false'].includes(values['open-signup'] ?? '')) {
    throw new ScriptError(EXIT.USAGE, 'Pass --open-signup true|false explicitly: it decides whether anyone with a Google login can join the sandbox');
  }
  if (values['member-uid'] !== undefined && !UID.test(values['member-uid'])) throw new ScriptError(EXIT.USAGE, 'Invalid --member-uid (a single Firebase Auth uid)');
  const target = resolveTarget({ project: values.project, approveProject: values['approve-project'], apply: values.apply, env });
  if (values['project-number'] !== undefined && !/^[1-9][0-9]{5,19}$/.test(values['project-number'])) throw new ScriptError(EXIT.USAGE, 'Invalid --project-number');
  return { target, openSignup: values['open-signup'] === 'true', memberUid: values['member-uid'], apply: values.apply, projectNumber: values['project-number'] };
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const canonical = (value) => value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

export async function seedDemo(options, deps) {
  const { target, openSignup, memberUid, apply, projectNumber } = options;
  const tenant = sandboxTenant(openSignup);
  deps.io.out(`${apply ? 'APPLY' : 'DRY RUN'}: project=${target.project} (${target.mode})`);
  deps.io.out(`  tenants/${SANDBOX_ID}: ${JSON.stringify(tenant)}`);
  if (memberUid) deps.io.out(`  memberships/${memberUid}: tenantId=${SANDBOX_ID} role=member (never admin)`);
  if (!apply) {
    deps.io.out('Nothing was read or written. Writes need --apply and --approve-project=<project>.');
    return EXIT.OK;
  }
  await verifyCloudProject(target, { client: (...args) => deps.cloudClient()(...args) }, projectNumber);
  const store = deps.firestore(target);

  const created = await store.create('tenants', SANDBOX_ID, tenant);
  if (created) deps.io.out('tenants/sandbox: created');
  else {
    const existing = await store.get(`tenants/${SANDBOX_ID}`);
    if (!existing || !same(existing.data, tenant)) {
      throw new ScriptError(EXIT.STATE, 'tenants/sandbox exists with different values; not overwriting. Inspect it and change it deliberately.');
    }
    deps.io.out('tenants/sandbox: unchanged');
  }

  if (memberUid) {
    const wanted = { tenantId: SANDBOX_ID, role: 'member', status: 'active', createdBy: 'operator', schemaVersion: 1 };
    const path = `memberships/${memberUid}`;
    const made = await store.create('memberships', memberUid, { ...wanted, updatedAt: new Date(deps.now()) });
    if (made) deps.io.out(`${path}: created (member)`);
    else {
      const existing = await store.get(path);
      const rest = Object.fromEntries(Object.entries(existing?.data ?? {}).filter(([key]) => key !== 'updatedAt'));
      if (!existing || !same(rest, wanted)) {
        throw new ScriptError(EXIT.STATE, `${path} exists with different values (tenant, role or status); not overwriting`);
      }
      deps.io.out(`${path}: unchanged`);
    }
  }
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
