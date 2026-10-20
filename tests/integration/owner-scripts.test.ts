import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs the real CLI scripts (scripts/grant-role.mjs, scripts/seed-demo.mjs) as child processes against
// the Firestore and Auth emulators only: exit codes, read-only dry runs, user checks, idempotency and refusals.
const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host) || !/^(127\.0\.0\.1|localhost):\d+$/.test(authHost)) {
  throw new Error('FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must identify local emulators');
}
const project = 'demo-queuepilot';
const docs = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const headers = { 'content-type': 'application/json', authorization: 'Bearer owner' };
const tenantId = `owner-test-${randomUUID().slice(0, 8)}`;
let uid = '';
let email = '';

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', FIRESTORE_EMULATOR_HOST: host, FIREBASE_AUTH_EMULATOR_HOST: authHost }, timeout: 30_000,
  });
  return { code: result.status, text: `${result.stdout}${result.stderr}` };
}
/** Creates an Auth emulator user through the Google provider (same mechanism as the API integration tests). */
async function googleUser(verified = true) {
  const sub = randomUUID();
  const address = `${sub.slice(0, 8)}@example.test`;
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', returnSecureToken: true,
      postBody: new URLSearchParams({ providerId: 'google.com', id_token: JSON.stringify({ sub, email: address, email_verified: verified }) }).toString() }),
  });
  const body = (await response.json()) as { localId: string };
  return { uid: body.localId, email: address };
}
const fetchDoc = async (path: string) => {
  const response = await fetch(`${docs}/${path}`, { headers });
  return response.status === 404 ? null : (await response.json()) as { fields: Record<string, Record<string, unknown>> };
};
const del = (path: string) => fetch(`${docs}/${path}`, { method: 'DELETE', headers });
const grant = (extra: string[], tenant = tenantId) => run('scripts/grant-role.mjs', ['--project', project, '--tenant', tenant, '--uid', uid, ...extra]);
const approved = () => ['--apply', '--approve-project', project, '--approve-uid', uid];

describe('owner scripts against the Firestore and Auth emulators', () => {
  beforeAll(async () => {
    ({ uid, email } = await googleUser());
    await del('tenants/sandbox');
    const created = await fetch(`${docs}/tenants?documentId=${tenantId}`, { method: 'POST', headers, body: JSON.stringify({ fields: {
      name: { stringValue: 'Owner script test' }, status: { stringValue: 'active' }, openSignup: { booleanValue: false },
      quotaMode: { stringValue: 'none' }, schemaVersion: { integerValue: '1' },
      limits: { mapValue: { fields: { submitPerMin: { integerValue: '1' }, submitPerDayUser: { integerValue: '1' }, submitPerDayTenant: { integerValue: '1' } } } },
    } }) });
    expect(created.status).toBe(200);
  });
  afterAll(async () => { await Promise.all([del('tenants/sandbox'), del(`tenants/${tenantId}`), del(`memberships/${uid}`)]); });

  it('grant-role: read-only dry run, refusals, approved create, idempotent rerun', async () => {
    const dry = grant([]);
    expect(dry.code, dry.text).toBe(0);
    expect(dry.text).toContain(`--approve-uid=${uid}`);
    expect(dry.text).not.toContain(email);
    expect(await fetchDoc(`memberships/${uid}`)).toBeNull();
    expect(grant(['--apply']).code).toBe(3); // no project approval
    expect(grant(['--apply', '--approve-project', 'demo-other']).code).toBe(3); // wrong approval
    expect(grant(['--apply', '--approve-project', project]).code).toBe(3); // no uid approval
    expect(grant(['--apply', '--approve-project', project, '--approve-uid', 'someone-else']).code).toBe(3); // wrong uid approval
    expect(grant(['--project', project]).code).toBe(2); // repeated --project is ambiguous
    const real = run('scripts/grant-role.mjs', ['--project', 'qp-real-project-1', '--tenant', tenantId, '--uid', uid, '--apply', '--approve-project', 'qp-real-project-1', '--approve-uid', uid]);
    expect(real.code).toBe(3); // emulator variables set: a non-demo project is refused before any request
    expect(grant(approved(), 'missing-tenant').code).toBe(4);
    expect(run('scripts/grant-role.mjs', ['--project', project, '--tenant', tenantId, '--uid', `missing-${randomUUID().slice(0, 8)}`]).code).toBe(4);
    const unverified = await googleUser(false);
    expect(run('scripts/grant-role.mjs', ['--project', project, '--tenant', tenantId, '--uid', unverified.uid]).code).toBe(4);
    expect(await fetchDoc(`memberships/${uid}`)).toBeNull();

    const byEmail = run('scripts/grant-role.mjs', ['--project', project, '--tenant', tenantId, '--email', email]);
    expect(byEmail.code, byEmail.text).toBe(0);
    expect(byEmail.text).toContain(`Resolved user: uid=${uid}`);

    const first = grant(approved());
    expect(first.code, first.text).toBe(0);
    const membership = await fetchDoc(`memberships/${uid}`);
    expect(membership?.fields).toMatchObject({
      tenantId: { stringValue: tenantId }, role: { stringValue: 'admin' }, status: { stringValue: 'active' },
      createdBy: { stringValue: 'operator' }, schemaVersion: { integerValue: '1' },
    });
    expect(membership?.fields.updatedAt).toHaveProperty('timestampValue');
    const second = grant(approved());
    expect(second.code).toBe(0);
    expect(second.text).toMatch(/nothing changed/);
  });

  it('grant-role: promotes an existing member and refuses to move a user between tenants', async () => {
    await del(`memberships/${uid}`);
    await fetch(`${docs}/memberships?documentId=${uid}`, { method: 'POST', headers, body: JSON.stringify({ fields: {
      tenantId: { stringValue: tenantId }, role: { stringValue: 'member' }, status: { stringValue: 'active' },
      createdBy: { stringValue: 'bootstrap' }, schemaVersion: { integerValue: '1' },
    } }) });
    expect(grant(approved()).code).toBe(0);
    expect((await fetchDoc(`memberships/${uid}`))?.fields).toMatchObject({ role: { stringValue: 'admin' }, createdBy: { stringValue: 'bootstrap' } });
    const other = `owner-test-${randomUUID().slice(0, 8)}`;
    await fetch(`${docs}/tenants?documentId=${other}`, { method: 'POST', headers, body: JSON.stringify({ fields: {
      name: { stringValue: 'Other' }, status: { stringValue: 'active' }, openSignup: { booleanValue: false },
      quotaMode: { stringValue: 'none' }, schemaVersion: { integerValue: '1' }, limits: { mapValue: { fields: {} } },
    } }) });
    try {
      expect(grant(approved(), other).code).toBe(4);
      expect((await fetchDoc(`memberships/${uid}`))?.fields.tenantId).toEqual({ stringValue: tenantId });
    } finally { await del(`tenants/${other}`); }
  });

  it('seed-demo: dry run, refusals, create, idempotent rerun, DRIFT without overwrite, no memberships', async () => {
    const seed = (extra: string[]) => run('scripts/seed-demo.mjs', ['--project', project, ...extra]);
    const apply = ['--apply', '--approve-project', project];
    expect(seed(['--open-signup', 'false']).code).toBe(0);
    expect(await fetchDoc('tenants/sandbox')).toBeNull();
    expect(seed(['--open-signup', 'false', '--apply']).code).toBe(3);
    expect(seed(apply).code).toBe(2); // signup choice is mandatory
    expect(seed(['--open-signup', 'false', ...apply, '--member-uid', uid]).code).toBe(2); // memberships are not the seed's job
    const created = seed(['--open-signup', 'false', ...apply]);
    expect(created.code, created.text).toBe(0);
    expect((await fetchDoc('tenants/sandbox'))?.fields).toMatchObject({ name: { stringValue: 'Sandbox' }, openSignup: { booleanValue: false }, quotaMode: { stringValue: 'enforced' } });
    const rerun = seed(['--open-signup', 'false', ...apply]);
    expect(rerun.code, rerun.text).toBe(0);
    expect(rerun.text).toMatch(/unchanged/);
    const drift = seed(['--open-signup', 'true', ...apply]);
    expect(drift.code).toBe(4);
    expect(drift.text).toMatch(/DRIFT tenants\/sandbox: fields differ from the seed: openSignup/);
    expect((await fetchDoc('tenants/sandbox'))?.fields.openSignup).toEqual({ booleanValue: false });
    expect((await fetchDoc(`memberships/${uid}`))?.fields).toMatchObject({ role: { stringValue: 'admin' } }); // untouched
  });
});
