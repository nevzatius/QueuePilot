import { pathToFileURL } from 'node:url';
import { accessToken, cloudClient } from '../infra/cloud.mjs';
import { EMAIL, EXIT, FirestoreRest, IdentityRest, ScriptError, TENANT_ID, UID, maskEmail, parseOptions, resolveTarget, runCli, verifyCloudProject } from './lib/ops.mjs';

// Owner-only admin grant (ARCHITECTURE §11, ADR-008/010). The only supported way to create an admin:
// no API path elevates a role, and this script never touches custom claims or IAM.
// Step 1, dry run (default): read-only. Resolves the user by --uid or --email, checks the account
// (exists, enabled, verified email, Google sign-in), the tenant and the current membership, and prints
// the resolved uid. Nothing is written.
// Step 2, apply: repeats every check and writes only if --approve-uid equals the uid printed in step 1.
//
//   node scripts/grant-role.mjs --project P --tenant T (--uid UID | --email EMAIL)
//   node scripts/grant-role.mjs --project P --tenant T (--uid UID | --email EMAIL) --apply --approve-project P --approve-uid UID [--project-number N]
//
// Credentials: the owner's own `gcloud auth login` token, exactly like infra/apply.mjs (no key files).
// Emulator: set FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST and use a demo-* project.

const OPTIONS = {
  project: { type: 'string' }, 'project-number': { type: 'string' }, 'approve-project': { type: 'string' }, tenant: { type: 'string' },
  uid: { type: 'string' }, email: { type: 'string' }, 'approve-uid': { type: 'string' },
  role: { type: 'string', default: 'admin' }, apply: { type: 'boolean', default: false },
};

export function parseGrantArgs(argv, env) {
  const values = parseOptions(argv, OPTIONS);
  if (values.role !== 'admin') throw new ScriptError(EXIT.USAGE, 'Only --role admin is supported');
  if (!values.tenant || !TENANT_ID.test(values.tenant)) throw new ScriptError(EXIT.USAGE, 'Missing or invalid --tenant (one explicit tenant slug; wildcards are not supported)');
  if (values.uid === undefined && values.email === undefined) throw new ScriptError(EXIT.USAGE, 'Pass --uid or --email to identify exactly one user');
  if (values.uid !== undefined && !UID.test(values.uid)) throw new ScriptError(EXIT.USAGE, 'Invalid --uid (a single Firebase Auth uid)');
  if (values.email !== undefined && !EMAIL.test(values.email)) throw new ScriptError(EXIT.USAGE, 'Invalid --email (a single address)');
  if (values['approve-uid'] !== undefined && !UID.test(values['approve-uid'])) throw new ScriptError(EXIT.USAGE, 'Invalid --approve-uid');
  const target = resolveTarget({ project: values.project, approveProject: values['approve-project'], apply: values.apply, env, requireAuthEmulator: true });
  if (values.apply && values['approve-uid'] === undefined) {
    throw new ScriptError(EXIT.REFUSED, 'Writes require --approve-uid=<uid printed by the dry run>');
  }
  if (values['project-number'] !== undefined && !/^[1-9][0-9]{5,19}$/.test(values['project-number'])) throw new ScriptError(EXIT.USAGE, 'Invalid --project-number');
  return { target, tenant: values.tenant, uid: values.uid, email: values.email, approveUid: values['approve-uid'], apply: values.apply, projectNumber: values['project-number'] };
}

/** Pure check of a resolved Auth account (ARCHITECTURE §11: verified email and Google sign-in only). */
export function checkAccount(users, { uid, email }) {
  if (users.length === 0) return 'No Auth user matches; the user must sign in with Google once before a grant';
  if (users.length > 1) return 'More than one Auth user matches; refusing an ambiguous grant';
  const [user] = users;
  if (typeof user.localId !== 'string' || !UID.test(user.localId)) return 'The Auth user has an unexpected uid';
  if (uid !== undefined && user.localId !== uid) return '--uid and --email identify different users';
  if (email !== undefined && String(user.email ?? '').toLowerCase() !== email.toLowerCase()) return '--uid and --email identify different users';
  if (user.disabled === true) return 'The Auth user is disabled';
  if (user.emailVerified !== true) return 'The Auth user has no verified email';
  if (!(user.providerUserInfo ?? []).some((provider) => provider.providerId === 'google.com')) return 'The Auth user has not signed in with Google';
  return null;
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
  const { target, tenant, uid, email, approveUid, apply, projectNumber } = options;
  const who = uid !== undefined ? `uid=${uid}` : `email=${maskEmail(email)}`;
  deps.io.out(`${apply ? 'APPLY' : 'DRY RUN (read-only)'}: project=${target.project} (${target.mode}) tenant=${tenant} ${who} role=admin`);
  await verifyCloudProject(target, { client: (...args) => deps.cloudClient()(...args) }, projectNumber);

  const users = await deps.identity(target).lookup(uid !== undefined ? { uid } : { email });
  const problem = checkAccount(users, { uid, email });
  if (problem) throw new ScriptError(EXIT.STATE, problem);
  const resolved = users[0].localId;
  deps.io.out(`Resolved user: uid=${resolved} email=${maskEmail(users[0].email)} (enabled, verified, Google)`);

  const store = deps.firestore(target);
  const tenantDocument = await store.get(`tenants/${tenant}`);
  if (!tenantDocument) throw new ScriptError(EXIT.STATE, 'Tenant does not exist; seed it first (scripts/seed-demo.mjs)');
  if (tenantDocument.data.status !== 'active') throw new ScriptError(EXIT.STATE, 'Tenant is not active');
  const path = `memberships/${resolved}`;
  const existing = await store.get(path);
  const decision = decideGrant(existing, tenant);
  if (decision.action === 'refuse') throw new ScriptError(EXIT.STATE, decision.reason);
  if (decision.action === 'noop') { deps.io.out('Already an active admin of this tenant: nothing changed.'); return EXIT.OK; }
  const change = decision.action === 'create' ? 'create an operator admin membership' : 'promote the existing active member to admin';

  if (!apply) {
    deps.io.out(`Would ${change} at ${path}. Nothing was written.`);
    deps.io.out(`To apply, rerun with --apply --approve-project=${target.project} --approve-uid=${resolved}`);
    return EXIT.OK;
  }
  if (approveUid !== resolved) throw new ScriptError(EXIT.REFUSED, '--approve-uid does not match the resolved user; rerun the dry run and copy its uid');
  const updatedAt = new Date(deps.now());
  if (decision.action === 'create') {
    const created = await store.create('memberships', resolved, { tenantId: tenant, role: 'admin', status: 'active', createdBy: 'operator', updatedAt, schemaVersion: 1 });
    if (!created) throw new ScriptError(EXIT.STATE, 'Membership appeared concurrently; rerun to re-evaluate');
    deps.io.out('Created admin membership.');
  } else {
    await store.update(path, { role: 'admin', updatedAt }, existing.updateTime);
    deps.io.out('Promoted existing member to admin.');
  }
  deps.io.out('The API caches memberships for up to 30 s (QP_MEMBERSHIP_CACHE_TTL); the change is effective after that.');
  return EXIT.OK;
}

// The gcloud token is requested only when a cloud request is actually made, never in emulator mode.
const token = () => {
  try { return accessToken(); }
  catch { throw new ScriptError(EXIT.IO, 'No gcloud access token; run `gcloud auth login` as the owner'); }
};
export const productionDeps = (io) => ({
  io, now: Date.now,
  cloudClient: () => cloudClient(token()),
  identity: (target) => new IdentityRest({ target, token: async () => token() }),
  firestore: (target) => new FirestoreRest({ target, token: async () => token() }),
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(async (argv, io) => grantRole(parseGrantArgs(argv, process.env), productionDeps(io)), process.argv.slice(2));
}
