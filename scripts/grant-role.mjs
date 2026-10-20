import { pathToFileURL } from 'node:url';
import { accessToken, cloudClient } from '../infra/cloud.mjs';
import { EXIT, FirestoreRest, ScriptError, TENANT_ID, UID, parseOptions, resolveTarget, runCli, verifyCloudProject } from './lib/ops.mjs';

// Owner-only admin grant (ARCHITECTURE §11, ADR-010). The only supported way to create an admin:
// no API path elevates a role. Dry run is the default and touches neither credentials nor network.
//
//   node scripts/grant-role.mjs --project P --tenant T --uid UID                       (dry run)
//   node scripts/grant-role.mjs --project P --tenant T --uid UID --apply --approve-project P [--project-number N]
//
// Credentials: the owner's own `gcloud auth login` token, exactly like infra/apply.mjs (no key files).
// Emulator: set FIRESTORE_EMULATOR_HOST and use a demo-* project.

const OPTIONS = {
  project: { type: 'string' }, 'project-number': { type: 'string' }, 'approve-project': { type: 'string' }, tenant: { type: 'string' }, uid: { type: 'string' },
  role: { type: 'string', default: 'admin' }, apply: { type: 'boolean', default: false },
};

export function parseGrantArgs(argv, env) {
  const values = parseOptions(argv, OPTIONS);
  if (values.role !== 'admin') throw new ScriptError(EXIT.USAGE, 'Only --role admin is supported');
  if (!values.tenant || !TENANT_ID.test(values.tenant)) throw new ScriptError(EXIT.USAGE, 'Missing or invalid --tenant (one explicit tenant slug; wildcards are not supported)');
  if (!values.uid || !UID.test(values.uid)) throw new ScriptError(EXIT.USAGE, 'Missing or invalid --uid (a single Firebase Auth uid)');
  const target = resolveTarget({ project: values.project, approveProject: values['approve-project'], apply: values.apply, env });
  if (values['project-number'] !== undefined && !/^[1-9][0-9]{5,19}$/.test(values['project-number'])) throw new ScriptError(EXIT.USAGE, 'Invalid --project-number');
  return { target, tenant: values.tenant, uid: values.uid, apply: values.apply, projectNumber: values['project-number'] };
}

/** Pure decision: what would change for this membership document. */
export function decideGrant(existing, tenant) {
  if (!existing) return { action: 'create' };
  const { tenantId, role, status } = existing.data;
  if (tenantId !== tenant) return { action: 'refuse', reason: 'The user already belongs to a different tenant; this script never moves memberships' };
  if (status !== 'active') return { action: 'refuse', reason: 'The membership is suspended; this script never reactivates it' };
  if (role === 'admin') return { action: 'noop' };
  if (role !== 'member') return { action: 'refuse', reason: 'Unexpected role value in the existing membership' };
  return { action: 'update' };
}

export async function grantRole(options, deps) {
  const { target, tenant, uid, apply, projectNumber } = options;
  const summary = `project=${target.project} (${target.mode}) tenant=${tenant} uid=${uid} role=admin`;
  if (!apply) {
    deps.io.out(`DRY RUN: nothing was read or written. Would grant: ${summary}`);
    deps.io.out('Writes need --apply and --approve-project=<project>.');
    return EXIT.OK;
  }
  deps.io.out(`APPLY: ${summary}`);
  await verifyCloudProject(target, { client: (...args) => deps.cloudClient()(...args) }, projectNumber);
  const store = deps.firestore(target);
  const tenantDocument = await store.get(`tenants/${tenant}`);
  if (!tenantDocument) throw new ScriptError(EXIT.STATE, 'Tenant does not exist; seed it first (scripts/seed-demo.mjs)');
  if (tenantDocument.data.status !== 'active') throw new ScriptError(EXIT.STATE, 'Tenant is not active');
  const path = `memberships/${uid}`;
  const existing = await store.get(path);
  const decision = decideGrant(existing, tenant);
  if (decision.action === 'refuse') throw new ScriptError(EXIT.STATE, decision.reason);
  if (decision.action === 'noop') { deps.io.out('Already an active admin of this tenant: nothing changed.'); return EXIT.OK; }
  const updatedAt = new Date(deps.now());
  if (decision.action === 'create') {
    const created = await store.create('memberships', uid, { tenantId: tenant, role: 'admin', status: 'active', createdBy: 'operator', updatedAt, schemaVersion: 1 });
    if (!created) throw new ScriptError(EXIT.STATE, 'Membership appeared concurrently; rerun to re-evaluate');
    deps.io.out('Created admin membership.');
  } else {
    await store.update(path, { role: 'admin', updatedAt }, existing.updateTime);
    deps.io.out('Promoted existing member to admin.');
  }
  deps.io.out('The API caches memberships for up to 30 s (QP_MEMBERSHIP_CACHE_TTL); the change is effective after that.');
  return EXIT.OK;
}

// The gcloud token is requested only when a cloud request is actually made, never in dry run or emulator mode.
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
  process.exitCode = await runCli(async (argv, io) => grantRole(parseGrantArgs(argv, process.env), productionDeps(io)), process.argv.slice(2));
}
