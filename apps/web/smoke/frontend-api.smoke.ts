/// <reference types="node" />
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemDetailsSchema } from '@queuepilot/contracts';
import { ApiError, createApiClient } from '../src/api/client.js';

// Drives the real web ApiClient against the built API server (apps/api/dist/server.js) over HTTP,
// backed by the Auth and Firestore emulators. Real Google sign-in is NOT exercised: the Auth emulator
// mints an ID token for the google.com provider. Run through `pnpm test:integration` (needs `pnpm build`).
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '';
const fsHost = process.env.FIRESTORE_EMULATOR_HOST ?? '';
for (const host of [authHost, fsHost]) {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host)) throw new Error('Auth and Firestore emulators must be local');
}
const PORT = Number(process.env.SMOKE_API_PORT ?? 18_080);
const base = `http://127.0.0.1:${PORT}`;
const docs = `http://${fsHost}/v1/projects/demo-queuepilot/databases/(default)/documents`;
const owner = { authorization: 'Bearer owner', 'content-type': 'application/json' };
let server: ChildProcess;
let token = '';

type FsDoc = { fields?: Record<string, { stringValue?: string }> };
const fsGet = async (path: string) => (await fetch(`${docs}/${path}`, { headers: owner })).json() as Promise<FsDoc & { documents?: unknown[] }>;

beforeAll(async () => {
  const limit = { integerValue: '10000' };
  const put = await fetch(`${docs}/tenants/sandbox`, {
    method: 'PATCH', headers: owner,
    body: JSON.stringify({ fields: {
      name: { stringValue: 'Sandbox' }, status: { stringValue: 'active' }, openSignup: { booleanValue: true },
      quotaMode: { stringValue: 'none' }, schemaVersion: { integerValue: '1' },
      limits: { mapValue: { fields: { submitPerMin: limit, submitPerDayUser: { integerValue: '30' }, submitPerDayTenant: { integerValue: '2000' } } } },
    } }),
  });
  expect(put.status).toBe(200);
  const id = randomUUID();
  const res = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', returnSecureToken: true,
      postBody: new URLSearchParams({ providerId: 'google.com', id_token: JSON.stringify({ sub: id, email: `${id}@example.test`, email_verified: true }) }).toString() }),
  });
  token = ((await res.json()) as { idToken: string }).idToken;
  server = spawn(process.execPath, ['apps/api/dist/server.js'], {
    env: { ...process.env, PORT: String(PORT), QP_ENV: 'test', GCLOUD_PROJECT: 'demo-queuepilot' }, stdio: 'ignore',
  });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/ready`)).ok) return; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('API server did not become ready');
}, 30_000);
afterAll(() => { server?.kill(); });

describe('web ApiClient -> built API -> Firestore emulator', () => {
  const client = () => createApiClient({ baseUrl: base, getToken: async () => token });

  it('runs session, bootstrap, submit, replay, list, detail and metrics', async () => {
    const api = client();
    expect((await api.me()).membership).toBeNull();
    const boot = await api.bootstrap();
    expect(boot.membership?.role).toBe('member');
    expect((await api.me()).membership?.tenantId).toBe(boot.membership?.tenantId);

    const key = randomUUID();
    const input = { type: 'general' as const, title: 'Smoke request', description: 'synthetic' };
    const created = await api.createRequest(input, key);
    expect(created.replayed).toBe(false);
    expect(await api.createRequest(input, key)).toMatchObject({ requestId: created.requestId, replayed: true });
    await expect(api.createRequest({ ...input, title: 'Different body' }, key)).rejects.toMatchObject({ status: 409 });

    expect((await fsGet(`requests/${created.requestId}`)).fields?.status?.stringValue).toBe('ACCEPTED');
    expect((await fsGet(`requests/${created.requestId}/events`)).documents).toHaveLength(1);

    const second = await api.createRequest({ ...input, title: 'Second' }, randomUUID());
    const page1 = await api.listRequests({ limit: 1 });
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await api.listRequests({ limit: 1, cursor: page1.nextCursor });
    expect(new Set([page1.items[0]?.requestId, page2.items[0]?.requestId])).toEqual(new Set([created.requestId, second.requestId]));

    const detail = await api.getRequest(created.requestId);
    expect(detail).toMatchObject({ requestId: created.requestId, status: 'ACCEPTED' });
    const metrics = await api.getMetrics();
    expect(JSON.stringify(metrics)).toBeTruthy();
  });

  it('maps failures to RFC 9457 problems', async () => {
    await expect(createApiClient({ baseUrl: base, getToken: async () => 'not-a-token' }).me()).rejects.toMatchObject({ status: 401 });
    await expect(client().getRequest(randomUUID())).rejects.toBeInstanceOf(ApiError);
    const raw = await fetch(`${base}/api/v1/requests/${randomUUID()}`, { headers: { authorization: `Bearer ${token}` } });
    expect(raw.headers.get('content-type')).toContain('application/problem+json');
    expect(ProblemDetailsSchema.safeParse(await raw.json()).success).toBe(true);
  });
});
