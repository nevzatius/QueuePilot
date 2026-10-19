import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CreateRequestResponseSchema, ListRequestsResponseSchema, MetricsResponseSchema, ProblemDetailsSchema, RequestDetailSchema } from '@queuepilot/contracts';
import {
  AdmissionControl, FirebaseTokenVerifier, FirestoreMembershipStore, FirestoreRequestRepository,
  loadConfig, MembershipService, MemoryRateLimiter, MetricsService,
} from '@queuepilot/core';
import type { QueuePort, Tenant } from '@queuepilot/core';
import { buildApp } from '../../src/app.js';

// No cloud credentials or production project can be used by this suite.
for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env[key] ?? '')) throw new Error(`${key} must be a local emulator`);
}
const firebase = initializeApp({ projectId: 'demo-queuepilot' }, `b3-${randomUUID()}`);
const db = getFirestore(firebase);
const auth = getAuth(firebase);
let now = Date.UTC(2026, 9, 19, 12);
const clock = { now: () => now };
const tenant: Tenant = { name: 'B3 test tenant', status: 'active', openSignup: true, quotaMode: 'none', schemaVersion: 1,
  limits: { submitPerMin: 10_000, submitPerDayUser: 30, submitPerDayTenant: 2000 } };
const payload = { type: 'general', title: 'Accepted test request', description: 'Private content' };
const apps: ReturnType<typeof buildApp>[] = [];
const users: string[] = [];
const tenantId = `test-${randomUUID().slice(0, 8)}`;
const otherTenantId = `test-${randomUUID().slice(0, 8)}`;
let alice: { uid: string; token: string };
let bob: typeof alice;
let admin: typeof alice;
let outsider: typeof alice;

async function identity(provider = 'google.com', verified = true) {
  const id = randomUUID();
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', returnSecureToken: true,
      postBody: new URLSearchParams({ providerId: provider, id_token: JSON.stringify({ sub: id, email: `${id}@example.test`, email_verified: verified }) }).toString() }),
  });
  expect(response.status).toBe(200);
  const result = await response.json() as { localId: string; idToken: string };
  users.push(result.localId);
  return { uid: result.localId, token: result.idToken };
}
const headers = (user: typeof alice, key = randomUUID()) => ({ authorization: `Bearer ${user.token}`, 'idempotency-key': key });
async function membership(user: typeof alice, selectedTenant: string, role = 'member') {
  await db.doc(`memberships/${user.uid}`).set({ tenantId: selectedTenant, role, status: 'active', createdBy: 'operator', updatedAt: Timestamp.fromMillis(now), schemaVersion: 1 });
}
function createApp() {
  const repo = new FirestoreRequestRepository(db, clock);
  const queue = { enqueue: vi.fn<QueuePort['enqueue']>(async () => {}) };
  const app = buildApp({
    config: loadConfig({ QP_ENV: 'test' }), verifier: new FirebaseTokenVerifier(auth),
    memberships: new MembershipService(new FirestoreMembershipStore(db), clock), requests: repo,
    admission: new AdmissionControl(clock, 1000, 32), metrics: new MetricsService(repo, clock),
    rateLimiter: new MemoryRateLimiter(clock, 1), bootstrapLimiter: new MemoryRateLimiter(clock, 1), queue, logger: false,
  });
  apps.push(app);
  return { app, queue, repo };
}
async function submit(app: ReturnType<typeof buildApp>, user = alice, key = randomUUID(), body = payload) {
  return app.inject({ method: 'POST', url: '/api/v1/requests', headers: headers(user, key), payload: body });
}

beforeAll(async () => {
  await Promise.all([db.doc(`tenants/${tenantId}`).set(tenant), db.doc(`tenants/${otherTenantId}`).set(tenant), db.doc('tenants/sandbox').set(tenant)]);
  [alice, bob, admin, outsider] = await Promise.all([identity(), identity(), identity(), identity()]);
  await Promise.all([membership(alice, tenantId), membership(bob, tenantId), membership(admin, tenantId, 'admin'), membership(outsider, otherTenantId, 'admin')]);
});
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await Promise.all(users.map((uid) => auth.deleteUser(uid)));
  await db.terminate();
  await deleteApp(firebase);
});

describe('B3 Auth/Firestore emulator integration', () => {
  it('denies absent, malformed, anonymous-provider and unverified credentials', async () => {
    const { app } = createApp();
    const unverified = await identity('google.com', false);
    const nonGoogle = await identity('facebook.com');
    for (const selected of [undefined, 'Bearer invalid', `Bearer ${unverified.token}`, `Bearer ${nonGoogle.token}`]) {
      const response = await app.inject({ url: '/api/v1/requests', headers: selected ? { authorization: selected } : {} });
      expect(response.statusCode).toBe(401);
      expect(ProblemDetailsSchema.safeParse(response.json()).success).toBe(true);
    }
  });
  it('bootstrap creates only a member, is idempotent and rejects role injection', async () => {
    const { app } = createApp();
    const fresh = await identity();
    expect((await app.inject({ url: '/api/v1/me', headers: headers(fresh) })).json().membership).toBeNull();
    expect((await app.inject({ url: '/api/v1/requests', headers: headers(fresh) })).json().code).toBe('ONBOARDING_REQUIRED');
    const bad = await app.inject({ method: 'POST', url: '/api/v1/session/bootstrap', headers: headers(fresh), payload: { role: 'admin', tenantId } });
    expect(bad.statusCode).toBe(400);
    expect((await db.doc(`memberships/${fresh.uid}`).get()).exists).toBe(false);
    const response = await app.inject({ method: 'POST', url: '/api/v1/session/bootstrap', headers: headers(fresh), payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ created: true, membership: { role: 'member', tenantId: 'sandbox' } });
    const replay = await app.inject({ method: 'POST', url: '/api/v1/session/bootstrap', headers: headers(fresh) });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ created: false, membership: { role: 'member' } });
  });
  it('persists request, key and ACCEPTED event atomically before enqueue', async () => {
    const { app, queue } = createApp();
    let observed: unknown;
    queue.enqueue.mockImplementation(async (task) => {
      const stored = await db.doc(`requests/${task.requestId}`).get();
      observed = { request: stored.data(), event: (await stored.ref.collection('events').doc('ACCEPTED-s1').get()).exists,
        keys: (await db.collection('idempotencyKeys').where('requestId', '==', task.requestId).get()).size };
    });
    const response = await submit(app);
    expect(response.statusCode).toBe(202);
    const accepted = CreateRequestResponseSchema.parse(response.json());
    expect(response.headers.location).toBe(accepted.location);
    expect(queue.enqueue).toHaveBeenCalledOnce();
    expect(observed).toMatchObject({ request: { status: 'ACCEPTED', tenantId, createdBy: alice.uid, processing: { attempts: 0, maxAttempts: 5 }, dispatch: { seq: 1, maxSeq: 3 } }, event: true, keys: 1 });
    const detail = await app.inject({ url: accepted.location, headers: headers(alice) });
    expect(detail.statusCode).toBe(200);
    expect(RequestDetailSchema.parse(detail.json())).toMatchObject({ status: 'ACCEPTED', events: [{ type: 'ACCEPTED', seq: 1 }] });
  });
  it('serializes concurrent same-key requests into one request/event/queue creator', async () => {
    const { app, queue } = createApp();
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(app, alice, key)));
    expect(responses.map((response) => response.statusCode)).toEqual(Array(8).fill(202));
    const ids = new Set(responses.map((response) => response.json().requestId as string));
    expect(ids.size).toBe(1);
    expect(responses.filter((response) => response.headers['idempotent-replayed'] === 'true')).toHaveLength(7);
    expect(queue.enqueue).toHaveBeenCalledOnce();
    const id = [...ids][0]!;
    expect((await db.doc(`requests/${id}`).collection('events').get()).size).toBe(1);
  });
  it('replays canonical defaults and returns 409 on changed content', async () => {
    const { app, queue } = createApp();
    const key = randomUUID();
    const initial = await submit(app, alice, key);
    const replay = await submit(app, alice, key, { ...payload, title: ` ${payload.title} `, priority: 'normal', attributes: {} } as typeof payload);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(initial.json());
    const conflict = await submit(app, alice, key, { ...payload, title: 'Different content' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(queue.enqueue).toHaveBeenCalledOnce();
  });
  it('takes over a logically expired key once under concurrency without TTL deletion', async () => {
    const { app, queue } = createApp();
    const key = randomUUID();
    const initial = await submit(app, alice, key);
    const oldId = initial.json().requestId as string;
    const record = (await db.collection('idempotencyKeys').where('requestId', '==', oldId).get()).docs[0]!;
    await record.ref.update({ expiresAt: Timestamp.fromMillis(now) });
    const responses = await Promise.all(Array.from({ length: 4 }, () => submit(app, alice, key)));
    expect(responses.every((response) => response.statusCode === 202)).toBe(true);
    const ids = new Set(responses.map((response) => response.json().requestId as string));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBe(oldId);
    expect((await db.doc(`requests/${oldId}`).get()).exists).toBe(true);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
  });
  it('scopes identical keys to tenant and UID', async () => {
    const { app } = createApp();
    const key = randomUUID();
    const responses = await Promise.all([submit(app, alice, key), submit(app, bob, key), submit(app, outsider, key)]);
    expect(responses.every((response) => response.statusCode === 202)).toBe(true);
    expect(new Set(responses.map((response) => response.json().requestId)).size).toBe(3);
  });
  it('denies cross-tenant and cross-user detail reads with 404; admins see only their tenant', async () => {
    const { app } = createApp();
    const created = await submit(app);
    const url = created.json().location as string;
    expect((await app.inject({ url, headers: headers(bob) })).statusCode).toBe(404);
    expect((await app.inject({ url, headers: headers(outsider) })).statusCode).toBe(404);
    expect((await app.inject({ url, headers: headers(admin) })).statusCode).toBe(200);
  });
  it('lists own requests and tenant admin pages, binds cursors to scope and tenant', async () => {
    const { app } = createApp();
    await Promise.all([submit(app), submit(app), submit(app, bob)]);
    const first = await app.inject({ url: '/api/v1/requests?limit=1', headers: headers(alice) });
    expect(first.statusCode).toBe(200);
    const page = ListRequestsResponseSchema.parse(first.json());
    expect(page.nextCursor).toBeTruthy();
    const second = await app.inject({ url: `/api/v1/requests?limit=1&cursor=${page.nextCursor}`, headers: headers(alice) });
    expect(second.statusCode).toBe(200);
    expect(second.json().items[0].requestId).not.toBe(page.items[0]!.requestId);
    expect((await app.inject({ url: `/api/v1/requests?cursor=${page.nextCursor}`, headers: headers(outsider) })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/v1/requests?scope=tenant', headers: headers(alice) })).statusCode).toBe(403);
    const tenantPage = await app.inject({ url: '/api/v1/requests?scope=tenant&limit=100', headers: headers(admin) });
    expect(tenantPage.statusCode).toBe(200);
    expect(tenantPage.json().items.length).toBeGreaterThan(page.items.length);
  });
  it('revokes cached admin privileges immediately for privileged reads', async () => {
    const operator = await identity();
    await membership(operator, tenantId, 'admin');
    const { app } = createApp();
    await app.inject({ url: '/api/v1/me', headers: headers(operator) });
    await membership(operator, tenantId, 'member');
    expect((await app.inject({ url: '/api/v1/requests?scope=tenant', headers: headers(operator) })).statusCode).toBe(403);
    const created = await submit(app);
    expect((await app.inject({ url: created.json().location, headers: headers(operator) })).statusCode).toBe(404);
  });
  it('returns tenant-isolated metrics and shares 5s memory cache', async () => {
    const { app } = createApp();
    const expected = (await db.collection('requests').where('tenantId', '==', otherTenantId).where('status', '==', 'ACCEPTED').count().get()).data().count;
    const response = await app.inject({ url: '/api/v1/metrics', headers: headers(outsider) });
    expect(response.statusCode).toBe(200);
    expect(MetricsResponseSchema.parse(response.json())).toMatchObject({ tenantId: otherTenantId, source: 'firestore', counts: { ACCEPTED: expected } });
    expect((await app.inject({ url: '/api/v1/metrics', headers: headers(outsider) })).json().source).toBe('memory');
    now += 5000;
    expect((await app.inject({ url: '/api/v1/metrics', headers: headers(outsider) })).json().source).toBe('firestore');
  });
  it('rolls back all acceptance writes when the emulator rejects the transaction commit', async () => {
    const { app, queue } = createApp();
    const requestCount = (await db.collection('requests').count().get()).data().count;
    const keysCount = (await db.collection('idempotencyKeys').count().get()).data().count;
    const eventsCount = (await db.collectionGroup('events').count().get()).data().count;
    const original = db.runTransaction.bind(db);
    const spy = vi.spyOn(db, 'runTransaction').mockImplementationOnce((operation, options) => original(async (tx) => {
      const result = await operation(tx);
      tx.update(db.doc(`b3Missing/${randomUUID()}`), { fail: true });
      return result;
    }, options));
    const key = randomUUID();
    const response = await submit(app, alice, key);
    spy.mockRestore();
    expect(response.statusCode).toBe(503);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect((await db.collection('requests').count().get()).data().count).toBe(requestCount);
    expect((await db.collection('idempotencyKeys').count().get()).data().count).toBe(keysCount);
    expect((await db.collectionGroup('events').count().get()).data().count).toBe(eventsCount);
    expect((await submit(app, alice, key)).statusCode).toBe(202);
  });
  it('queue failure leaves ACCEPTED with a watchdog and no premature FAILED event', async () => {
    const { app, queue } = createApp();
    queue.enqueue.mockRejectedValue(new Error('Cloud Tasks unavailable'));
    const key = randomUUID();
    const response = await submit(app, alice, key);
    expect(response.statusCode).toBe(202);
    const requestId = response.json().requestId as string;
    const stored = await db.doc(`requests/${requestId}`).get();
    expect(stored.data()).toMatchObject({ status: 'ACCEPTED', dispatch: { seq: 1 }, processing: { attempts: 0 } });
    expect(stored.get('watchdogAt').toMillis()).toBe(now + 60_000);
    const events = await stored.ref.collection('events').get();
    expect(events.docs.map((event) => event.get('type'))).toEqual(['ACCEPTED']);
    expect((await submit(app, alice, key)).headers['idempotent-replayed']).toBe('true');
    expect(queue.enqueue).toHaveBeenCalledOnce();
  });
  it('rejects invalid content and client ownership fields without persistence', async () => {
    const { app, queue } = createApp();
    const count = (await db.collection('requests').count().get()).data().count;
    for (const body of [{ ...payload, title: '' }, { ...payload, tenantId: otherTenantId }, { ...payload, createdBy: admin.uid }]) {
      expect((await submit(app, alice, randomUUID(), body)).statusCode).toBe(400);
    }
    expect((await db.collection('requests').count().get()).data().count).toBe(count);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });
});
