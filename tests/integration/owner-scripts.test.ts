import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Runs the real CLI scripts (scripts/grant-role.mjs, scripts/seed-demo.mjs) as child processes against
// the Firestore emulator only: exit codes, dry-run behaviour, idempotency and project refusal.
const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('FIRESTORE_EMULATOR_HOST must identify a local emulator');
const project = 'demo-queuepilot';
const docs = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
const headers = { 'content-type': 'application/json', authorization: 'Bearer owner' };
const tenantId = `owner-test-${randomUUID().slice(0, 8)}`;
const uid = `owner-test-${randomUUID().slice(0, 8)}`;

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', FIRESTORE_EMULATOR_HOST: host }, timeout: 30_000,
  });
  return { code: result.status, text: `${result.stdout}${result.stderr}` };
}
const fetchDoc = async (path: string) => {
  const response = await fetch(`${docs}/${path}`, { headers });
  return response.status === 404 ? null : (await response.json()) as { fields: Record<string, Record<string, unknown>> };
};
const del = (path: string) => fetch(`${docs}/${path}`, { method: 'DELETE', headers });
const grant = (extra: string[], tenant = tenantId) => run('scripts/grant-role.mjs', ['--project', project, '--tenant', tenant, '--uid', uid, ...extra]);
const approved = ['--apply', '--approve-project', project];

describe('owner scripts against the Firestore emulator', () => {
  beforeAll(async () => {
    await del('tenants/sandbox');
    const created = await fetch(`${docs}/tenants?documentId=${tenantId}`, { method: 'POST', headers, body: JSON.stringify({ fields: {
      name: { stringValue: 'Owner script test' }, status: { stringValue: 'active' }, openSignup: { booleanValue: false },
      quotaMode: { stringValue: 'none' }, schemaVersion: { integerValue: '1' },
      limits: { mapValue: { fields: { submitPerMin: { integerValue: '1' }, submitPerDayUser: { integerValue: '1' }, submitPerDayTenant: { integerValue: '1' } } } },
    } }) });
    expect(created.status).toBe(200);
  });
  afterAll(async () => { await Promise.all([del('tenants/sandbox'), del(`tenants/${tenantId}`), del(`memberships/${uid}`)]); });

  it('grant-role: dry run, refusals, create, idempotent rerun', async () => {
    expect(grant([]).code).toBe(0);
    expect(await fetchDoc(`memberships/${uid}`)).toBeNull();
    expect(grant(['--apply']).code).toBe(3); // no project approval
    expect(grant(['--apply', '--approve-project', 'demo-other']).code).toBe(3); // wrong approval
    expect(grant(['--project', project]).code).toBe(2); // repeated --project is ambiguous
    const real = run('scripts/grant-role.mjs', ['--project', 'qp-real-project-1', '--tenant', tenantId, '--uid', uid, '--apply', '--approve-project', 'qp-real-project-1']);
    expect(real.code).toBe(3); // emulator host set: a non-demo project is refused before any request
    expect(grant(approved, 'missing-tenant').code).toBe(4);
    expect(await fetchDoc(`memberships/${uid}`)).toBeNull();

    const first = grant(approved);
    expect(first.code, first.text).toBe(0);
    const membership = await fetchDoc(`memberships/${uid}`);
    expect(membership?.fields).toMatchObject({
      tenantId: { stringValue: tenantId }, role: { stringValue: 'admin' }, status: { stringValue: 'active' },
      createdBy: { stringValue: 'operator' }, schemaVersion: { integerValue: '1' },
    });
    expect(membership?.fields.updatedAt).toHaveProperty('timestampValue');
    const second = grant(approved);
    expect(second.code).toBe(0);
    expect(second.text).toMatch(/nothing changed/);
  });

  it('grant-role: promotes an existing member and refuses to move a user between tenants', async () => {
    await del(`memberships/${uid}`);
    await fetch(`${docs}/memberships?documentId=${uid}`, { method: 'POST', headers, body: JSON.stringify({ fields: {
      tenantId: { stringValue: tenantId }, role: { stringValue: 'member' }, status: { stringValue: 'active' },
      createdBy: { stringValue: 'bootstrap' }, schemaVersion: { integerValue: '1' },
    } }) });
    expect(grant(approved).code).toBe(0);
    expect((await fetchDoc(`memberships/${uid}`))?.fields).toMatchObject({ role: { stringValue: 'admin' }, createdBy: { stringValue: 'bootstrap' } });
    const other = `owner-test-${randomUUID().slice(0, 8)}`;
    await fetch(`${docs}/tenants?documentId=${other}`, { method: 'POST', headers, body: JSON.stringify({ fields: {
      name: { stringValue: 'Other' }, status: { stringValue: 'active' }, openSignup: { booleanValue: false },
      quotaMode: { stringValue: 'none' }, schemaVersion: { integerValue: '1' }, limits: { mapValue: { fields: {} } },
    } }) });
    try {
      expect(grant(approved, other).code).toBe(4);
      expect((await fetchDoc(`memberships/${uid}`))?.fields.tenantId).toEqual({ stringValue: tenantId });
    } finally { await del(`tenants/${other}`); }
  });

  it('seed-demo: dry run, refusals, create, idempotent rerun, drift refusal, member-only membership', async () => {
    const seed = (extra: string[]) => run('scripts/seed-demo.mjs', ['--project', project, ...extra]);
    expect(seed(['--open-signup', 'false']).code).toBe(0);
    expect(await fetchDoc('tenants/sandbox')).toBeNull();
    expect(seed(['--open-signup', 'false', '--apply']).code).toBe(3);
    expect(seed(['--apply', '--approve-project', project]).code).toBe(2); // signup choice is mandatory
    const memberUid = `owner-test-${randomUUID().slice(0, 8)}`;
    try {
      const created = seed(['--open-signup', 'false', ...approved, '--member-uid', memberUid]);
      expect(created.code, created.text).toBe(0);
      expect((await fetchDoc('tenants/sandbox'))?.fields).toMatchObject({ name: { stringValue: 'Sandbox' }, openSignup: { booleanValue: false }, quotaMode: { stringValue: 'enforced' } });
      expect((await fetchDoc(`memberships/${memberUid}`))?.fields).toMatchObject({ tenantId: { stringValue: 'sandbox' }, role: { stringValue: 'member' }, createdBy: { stringValue: 'operator' } });
      const rerun = seed(['--open-signup', 'false', ...approved, '--member-uid', memberUid]);
      expect(rerun.code, rerun.text).toBe(0);
      expect(rerun.text).toMatch(/unchanged/);
    } finally { await del(`memberships/${memberUid}`); }
    // The admin of another tenant (from the grant tests) is never overwritten by the seed.
    const conflict = seed(['--open-signup', 'false', ...approved, '--member-uid', uid]);
    expect(conflict.code).toBe(4);
    expect(conflict.text).toMatch(/not overwriting/);
    expect((await fetchDoc(`memberships/${uid}`))?.fields).toMatchObject({ role: { stringValue: 'admin' } });
    expect(seed(['--open-signup', 'false', ...approved]).code).toBe(0); // tenant alone: unchanged
    expect(seed(['--open-signup', 'true', ...approved]).code).toBe(4); // drift is reported, not overwritten
    expect((await fetchDoc('tenants/sandbox'))?.fields.openSignup).toEqual({ booleanValue: false });
  });
});
