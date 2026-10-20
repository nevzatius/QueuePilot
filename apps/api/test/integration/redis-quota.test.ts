import { randomUUID } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AdmissionControl, FirebaseTokenVerifier, FirestoreMembershipStore, FirestoreQuotaSubmission, FirestoreRequestRepository,
  ManagedRedis, MembershipService, MemoryRateLimiter, MetricsService, RedisQuotaStore, createRedisConnection, loadConfig,
} from '@queuepilot/core';
import type { QueuePort, Tenant } from '@queuepilot/core';
import { buildApp } from '../../src/app.js';

// Real API app + Firestore/Auth emulators + REAL Redis (REDIS_URL, default local). Only the Cloud Tasks queue port is a double.
// Needs Redis: run via the root pnpm test:integration (CI), not the emulator-only apps/api runner.
for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) {
  if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env[key] ?? '')) throw new Error(`${key} must be a local emulator`);
}
const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const parsedUrl = new URL(url);
if (parsedUrl.protocol !== 'redis:' || !['localhost', '127.0.0.1'].includes(parsedUrl.hostname)) {
  throw new Error('REDIS_URL must identify local Redis');
}
const firebase = initializeApp({ projectId: 'demo-queuepilot' }, `redis-http-${randomUUID()}`);
const db = getFirestore(firebase);
const auth = getAuth(firebase);
const now = Date.UTC(2026, 9, 20, 12); // 12 h before UTC midnight => Retry-After 43200 s.
const clock = { now: () => now };
const base: Tenant = { name: 'Redis HTTP tenant', status: 'active', openSignup: true, quotaMode: 'enforced', schemaVersion: 1,
  limits: { submitPerMin: 10_000, submitPerDayUser: 2, submitPerDayTenant: 10 } };
const payload = { type: 'general', title: 'Real Redis quota request', description: 'Synthetic content' };
const prefix = `rh-${randomUUID().slice(0, 8)}`;
const users: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
const redisClients: ManagedRedis[] = [];
const admin = createRedisConnection(url);

async function identity() {
  const id = randomUUID();
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', returnSecureToken: true,
      postBody: new URLSearchParams({ providerId: 'google.com', id_token: JSON.stringify({ sub: id, email: `${id}@example.test`, email_verified: true }) }).toString() }),
  });
  expect(response.status).toBe(200);
  const result = await response.json() as { localId: string; idToken: string };
  users.push(result.localId);
  return { uid: result.localId, token: result.idToken };
}
async function enrolled(limits: Partial<Tenant['limits']> = {}) {
  const user = await identity();
  const tenantId = `${prefix}-${randomUUID().slice(0, 6)}`;
  await db.doc(`tenants/${tenantId}`).set({ ...base, limits: { ...base.limits, ...limits } });
  await db.doc(`memberships/${user.uid}`).set({ tenantId, role: 'member', status: 'active', createdBy: 'operator', updatedAt: Timestamp.fromMillis(now), schemaVersion: 1 });
  return { user, tenantId };
}
function createApp(redisUrl: string) {
  const redis = new ManagedRedis(createRedisConnection(redisUrl), clock);
  redisClients.push(redis);
  const repo = new FirestoreRequestRepository(db, clock);
  const queue = { enqueue: vi.fn<QueuePort['enqueue']>(async () => {}) };
  const app = buildApp({
    config: loadConfig({ QP_ENV: 'test' }), verifier: new FirebaseTokenVerifier(auth),
    memberships: new MembershipService(new FirestoreMembershipStore(db), clock), requests: repo,
    admission: new AdmissionControl(clock, 1000, 32), metrics: new MetricsService(repo, clock),
    rateLimiter: new MemoryRateLimiter(clock, 1), bootstrapLimiter: new MemoryRateLimiter(clock, 1), queue, logger: false,
    submission: new FirestoreQuotaSubmission(db, clock, new RedisQuotaStore(redis, clock), { warn: () => {} }),
  });
  apps.push(app);
  return { app, queue };
}
const submit = (app: ReturnType<typeof buildApp>, user: { token: string }, key = randomUUID()) =>
  app.inject({ method: 'POST', url: '/api/v1/requests', headers: { authorization: `Bearer ${user.token}`, 'idempotency-key': key }, payload });
const stored = async (tenantId: string) => (await db.collection('requests').where('tenantId', '==', tenantId).count().get()).data().count;

beforeAll(async () => { await admin.connect(); });
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await Promise.all(redisClients.map((redis) => redis.close()));
  await Promise.all(users.map((uid) => auth.deleteUser(uid)));
  try {
    if (admin.status === 'ready') {
      const keys = await (admin as unknown as { keys(pattern: string): Promise<string[]> }).keys(`qp:quota:{${prefix}*`);
      if (keys.length) await admin.eval("return redis.call('DEL', unpack(KEYS))", keys.length, ...keys);
      await admin.quit();
    }
  } finally { admin.disconnect(); }
  await db.terminate();
  await deleteApp(firebase);
});

describe('HTTP API with a real Redis quota store', () => {
  it('accepts exactly the user budget, then returns 429 QUOTA_EXCEEDED with matching Retry-After header and body', async () => {
    const { user, tenantId } = await enrolled();
    const { app } = createApp(url);
    expect((await submit(app, user)).statusCode).toBe(202);
    expect((await submit(app, user)).statusCode).toBe(202);
    const over = await submit(app, user);
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: 'QUOTA_EXCEEDED', retryAfterSeconds: 43_200 });
    expect(Number(over.headers['retry-after'])).toBe(43_200);
    expect(await stored(tenantId)).toBe(2);
  });

  it('replays an idempotent submission without charging quota again', async () => {
    const { user, tenantId } = await enrolled({ submitPerDayUser: 1 });
    const { app, queue } = createApp(url);
    const key = randomUUID();
    const first = await submit(app, user, key);
    expect(first.statusCode).toBe(202);
    const replay = await submit(app, user, key); // Would be 429 if replay consumed the exhausted budget.
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await submit(app, user)).statusCode).toBe(429); // A genuinely new key is over budget.
    expect(await stored(tenantId)).toBe(1);
    expect(queue.enqueue).toHaveBeenCalledOnce();
  });

  it('keeps tenant budgets separate over HTTP', async () => {
    const [one, two] = [await enrolled({ submitPerDayUser: 1 }), await enrolled({ submitPerDayUser: 1 })];
    const { app } = createApp(url);
    expect((await submit(app, one.user)).statusCode).toBe(202);
    expect((await submit(app, one.user)).statusCode).toBe(429);
    expect((await submit(app, two.user)).statusCode).toBe(202);
  });

  it('admits exactly N of N+k concurrent distinct submissions and stores no extra requests', async () => {
    const { user, tenantId } = await enrolled({ submitPerDayUser: 3 });
    const { app } = createApp(url);
    const responses = await Promise.all(Array.from({ length: 8 }, () => submit(app, user)));
    expect(responses.filter((r) => r.statusCode === 202)).toHaveLength(3);
    expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(5);
    expect(await stored(tenantId)).toBe(3);
  });

  it('fails closed with 503 QUOTA_UNAVAILABLE when Redis is down, while replays of accepted work still succeed', async () => {
    const { user, tenantId } = await enrolled();
    const key = randomUUID();
    const healthy = createApp(url);
    const first = await submit(healthy.app, user, key);
    expect(first.statusCode).toBe(202);
    const down = createApp('redis://127.0.0.1:1');
    const replay = await submit(down.app, user, key);
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const refused = await submit(down.app, user);
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'QUOTA_UNAVAILABLE', retryAfterSeconds: 30 });
    expect(Number(refused.headers['retry-after'])).toBe(30);
    expect(await stored(tenantId)).toBe(1);
    expect(down.queue.enqueue).not.toHaveBeenCalled();
  });
});
