import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { Auth } from 'firebase-admin/auth';
import { describe, expect, it, vi } from 'vitest';
import { ProblemDetailsSchema } from '@queuepilot/contracts';
import {
  AdmissionControl, ApiError, FirebaseTokenVerifier, loadConfig, createLogger, MembershipService,
  MemoryRateLimiter, MetricsService, enqueueAccepted,
} from '@queuepilot/core';
import type { MembershipStore, RequestRepository, Tenant } from '@queuepilot/core';
import { buildApp } from '../src/app.js';

const tenant: Tenant = { name: 'Sandbox', status: 'active', openSignup: true, quotaMode: 'none', schemaVersion: 1,
  limits: { submitPerMin: 1000, submitPerDayUser: 30, submitPerDayTenant: 2000 } };
function fixture() {
  let now = 1000;
  const clock = { now: () => now };
  const member = { tenantId: 'sandbox', role: 'member' as 'member' | 'admin', status: 'active' as 'active' | 'suspended', schemaVersion: 1 as const };
  const store = {
    member: vi.fn(async () => ({ ...member })), tenant: vi.fn(async () => ({ ...tenant })), bootstrap: vi.fn(async () => true),
  };
  const memberships = new MembershipService(store, clock);
  const repo: RequestRepository = {
    submit: vi.fn(async () => ({ requestId: randomUUID(), replayed: false })),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    detail: vi.fn(async () => { throw new ApiError('NOT_FOUND'); }),
    metrics: vi.fn<RequestRepository['metrics']>(async (tenantId) => ({ tenantId, generatedAt: new Date(now).toISOString(), source: 'firestore', counts: { ACCEPTED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 }, stuck: 0 })),
    backlog: vi.fn(async () => 0), health: vi.fn(async () => {}),
  };
  const queue = { enqueue: vi.fn(async () => {}) };
  const verifier = { verify: vi.fn(async (token: string) => {
    if (token !== 'valid') throw new ApiError('UNAUTHENTICATED');
    return { uid: 'alice', email: null };
  }) };
  const deps = { config: loadConfig({ QP_ENV: 'test' }), verifier, memberships, requests: repo,
    queue, admission: new AdmissionControl(clock), metrics: new MetricsService(repo, clock),
    rateLimiter: new MemoryRateLimiter(clock, 1), logger: false };
  const app = buildApp(deps);
  return { app, deps, repo, store, member, queue, clock, tick: (ms: number) => { now += ms; } };
}
const headers = { authorization: 'Bearer valid', 'idempotency-key': 'same-key-123' };
const payload = { type: 'general', title: 'Test request' };

describe('API boundary', () => {
  it('requires auth and emits RFC9457 with a server-generated correlation ID', async () => {
    const { app, repo } = fixture();
    const response = await app.inject({ method: 'POST', url: '/api/v1/requests', payload, headers: { 'x-correlation-id': 'attacker' } });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem.correlationId).not.toBe('attacker');
    expect(response.headers['x-correlation-id']).toBe(problem.correlationId);
    expect(repo.submit).not.toHaveBeenCalled();
    await app.close();
  });
  it.each([
    { ...payload, tenantId: 'other' }, { ...payload, createdBy: 'admin' },
    { ...payload, title: 'x' }, { ...payload, attributes: { nested: {} } },
  ])('rejects invalid payloads before persistence', async (body) => {
    const { app, repo } = fixture();
    const response = await app.inject({ method: 'POST', url: '/api/v1/requests', headers, payload: body });
    expect(response.statusCode).toBe(400);
    expect(repo.submit).not.toHaveBeenCalled();
    await app.close();
  });
  it('requires a valid idempotency key', async () => {
    const { app, repo } = fixture();
    expect((await app.inject({ method: 'POST', url: '/api/v1/requests', headers: { authorization: 'Bearer valid' }, payload })).statusCode).toBe(400);
    expect(repo.submit).not.toHaveBeenCalled();
    await app.close();
  });
  it('never enqueues before commit; queue failure preserves 202 and never performs a status write', async () => {
    const { app, repo, queue } = fixture();
    let committed = false;
    vi.mocked(repo.submit).mockImplementation(async () => { committed = true; return { requestId: randomUUID(), replayed: false }; });
    queue.enqueue.mockImplementation(async () => { expect(committed).toBe(true); throw new Error('queue unavailable'); });
    const response = await app.inject({ method: 'POST', url: '/api/v1/requests', headers, payload });
    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(response.json().location);
    expect(repo.submit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'sandbox', uid: 'alice', body: { ...payload, description: '', priority: 'normal', attributes: {} } }));
    expect(queue.enqueue).toHaveBeenCalledOnce();
    await app.close();
  });
  it('replays without a second queue creator', async () => {
    const { app, repo, queue } = fixture();
    vi.mocked(repo.submit).mockResolvedValue({ requestId: randomUUID(), replayed: true });
    const response = await app.inject({ method: 'POST', url: '/api/v1/requests', headers, payload });
    expect(response.statusCode).toBe(202);
    expect(response.headers['idempotent-replayed']).toBe('true');
    expect(queue.enqueue).not.toHaveBeenCalled();
    await app.close();
  });
  it('commit failure yields 503 and no queue call', async () => {
    const { app, repo, queue } = fixture();
    vi.mocked(repo.submit).mockRejectedValue(new ApiError('SERVICE_UNAVAILABLE', 1));
    const response = await app.inject({ method: 'POST', url: '/api/v1/requests', headers, payload });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 1 });
    expect(queue.enqueue).not.toHaveBeenCalled();
    await app.close();
  });
  it('fails enforced quotas closed before writes', async () => {
    const { app, store, repo } = fixture();
    store.tenant.mockResolvedValue({ ...tenant, quotaMode: 'enforced' });
    const response = await app.inject({ method: 'POST', url: '/api/v1/requests', headers, payload });
    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe('QUOTA_UNAVAILABLE');
    expect(repo.submit).not.toHaveBeenCalled();
    await app.close();
  });
  it('rejects bootstrap role input without a write', async () => {
    const { app, store } = fixture();
    const response = await app.inject({ method: 'POST', url: '/api/v1/session/bootstrap', headers, payload: { role: 'admin' } });
    expect(response.statusCode).toBe(400);
    expect(store.bootstrap).not.toHaveBeenCalled();
    await app.close();
  });
  it('accepts an absent bootstrap body and an empty object', async () => {
    const { app, store } = fixture();
    for (const body of [undefined, {}]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/session/bootstrap', headers,
        ...(body === undefined ? {} : { payload: body }) });
      expect(response.statusCode).toBe(200);
      expect(response.json().membership.role).toBe('member');
    }
    expect(store.bootstrap).toHaveBeenCalledTimes(2);
    await app.close();
  });
  it('returns admission overload and backlog errors before persistence', async () => {
    const { app, deps, repo } = fixture();
    vi.spyOn(deps.admission, 'acquire').mockRejectedValueOnce(new ApiError('OVERLOADED', 1))
      .mockRejectedValueOnce(new ApiError('BACKLOG_FULL', 5));
    for (const code of ['OVERLOADED', 'BACKLOG_FULL']) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/requests', headers, payload });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe(code);
    }
    expect(repo.submit).not.toHaveBeenCalled();
    await app.close();
  });
  it('rechecks cached admin privileges uncached for tenant listing and cross-user detail', async () => {
    const { app, member, repo } = fixture();
    member.role = 'admin';
    await app.inject({ url: '/api/v1/me', headers });
    member.role = 'member';
    const list = await app.inject({ url: '/api/v1/requests?scope=tenant', headers });
    expect(repo.list).not.toHaveBeenCalled();
    expect(list.statusCode).toBe(403);
    await app.close();
  });
  it('health is public; readiness fails safely without exposing dependency errors', async () => {
    const { app, repo } = fixture();
    expect((await app.inject('/health')).statusCode).toBe(200);
    vi.mocked(repo.health).mockRejectedValue(new ApiError('SERVICE_UNAVAILABLE'));
    const response = await app.inject('/ready');
    expect(response.statusCode).toBe(503);
    expect(ProblemDetailsSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });
  it('returns problem details for malformed JSON, large bodies and missing routes', async () => {
    const { app } = fixture();
    for (const response of [
      await app.inject({ method: 'POST', url: '/api/v1/requests', headers: { ...headers, 'content-type': 'application/json' }, payload: '{' }),
      await app.inject({ method: 'POST', url: '/api/v1/requests', headers, payload: { ...payload, description: 'a'.repeat(40_000) } }),
      await app.inject({ url: '/api/v1/missing', headers }),
    ]) expect(ProblemDetailsSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });
});

describe('membership consistency ADR-010', () => {
  it('expires positive membership/tenant entries by 30s and fails closed on refresh errors', async () => {
    const { deps, store, member, tick } = fixture();
    await deps.memberships.require('alice');
    member.status = 'suspended';
    tick(29_999);
    expect((await deps.memberships.require('alice')).membership.status).toBe('active');
    tick(1);
    await expect(deps.memberships.require('alice')).rejects.toMatchObject({ code: 'MEMBERSHIP_SUSPENDED' });
    tick(30_000);
    store.member.mockRejectedValue(new Error('firestore unavailable'));
    await expect(deps.memberships.require('alice')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it('never caches negatives and never extends tenant kill-switch TTL', async () => {
    let now = 0;
    const store: MembershipStore = { member: vi.fn(async () => null), tenant: vi.fn(async () => ({ ...tenant })), bootstrap: vi.fn(async () => true) };
    const service = new MembershipService(store, { now: () => now });
    expect(await service.lookup('alice')).toBeNull();
    vi.mocked(store.member).mockResolvedValue({ tenantId: 'sandbox', role: 'member', status: 'active', schemaVersion: 1 });
    await service.require('alice');
    vi.mocked(store.tenant).mockResolvedValue({ ...tenant, status: 'suspended' });
    now = 30_000;
    await expect(service.require('alice')).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
  });
  it('admin uncached reads fail closed even when a positive entry exists', async () => {
    const { deps, store } = fixture();
    await deps.memberships.require('alice');
    store.member.mockRejectedValue(new Error('offline'));
    await expect(deps.memberships.require('alice', true)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('auth, production guards, bounds and logging', () => {
  it.each([
    { email_verified: false, firebase: { sign_in_provider: 'google.com' } },
    { email_verified: true, firebase: { sign_in_provider: 'password' } },
  ])('rejects unsupported Firebase identities', async (claims) => {
    const auth = { verifyIdToken: vi.fn(async () => ({ uid: 'alice', ...claims })) };
    await expect(new FirebaseTokenVerifier(auth as unknown as Auth).verify('token')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(auth.verifyIdToken).toHaveBeenCalledWith('token', false);
  });
  it('ignores custom tenant/admin claims', async () => {
    const auth = { verifyIdToken: vi.fn(async () => ({ uid: 'alice', email_verified: true, tenantId: 'other', role: 'admin', firebase: { sign_in_provider: 'google.com' } })) };
    expect(await new FirebaseTokenVerifier(auth as unknown as Auth).verify('token')).toEqual({ uid: 'alice', email: null });
  });
  it.each(['QP_FAULT_CREATE', 'QP_FAULT_UNUSED'])('refuses production fault flags including false values: %s', (key) => {
    expect(() => loadConfig({ QP_ENV: 'production', GCLOUD_PROJECT: 'real-project', [key]: 'false' })).toThrow();
  });
  it('refuses production quota fail-open and emulator endpoints', () => {
    expect(() => loadConfig({ QP_ENV: 'production', GCLOUD_PROJECT: 'real-project', QP_QUOTA_FAILURE_MODE: 'open' })).toThrow();
    expect(() => loadConfig({ QP_ENV: 'production', GCLOUD_PROJECT: 'real-project', FIRESTORE_EMULATOR_HOST: 'localhost:8080' })).toThrow();
    expect(() => loadConfig({ QP_MEMBERSHIP_CACHE_TTL: '31' })).toThrow();
  });
  it('bounds token bucket, semaphore and backlog before writes; releases slots on failures', async () => {
    const clock = { now: () => 0 };
    const admission = new AdmissionControl(clock, 10, 1, 2);
    const release = await admission.acquire();
    await expect(admission.acquire()).rejects.toMatchObject({ code: 'OVERLOADED' });
    release(); release();
    await expect(admission.acquire(async () => 3)).rejects.toMatchObject({ code: 'BACKLOG_FULL' });
    (await admission.acquire(async () => { throw new Error('metrics down'); }))();
    const bucket = new AdmissionControl(clock, 1);
    (await bucket.acquire())();
    await expect(bucket.acquire()).rejects.toMatchObject({ code: 'OVERLOADED' });
  });
  it('bounds enqueue latency and aborts a stalled adapter', async () => {
    let signal: AbortSignal | undefined;
    await expect(enqueueAccepted({ enqueue: async (_, received) => { signal = received; return new Promise(() => {}); } },
      { requestId: randomUUID(), tenantId: 'sandbox', seq: 1, correlationId: 'test' }, 5)).rejects.toThrow('Enqueue timeout');
    expect(signal?.aborted).toBe(true);
  });
  it('uses tenant-isolated single-flight metrics with 5s expiry', async () => {
    const { deps, repo, tick } = fixture();
    await Promise.all([deps.metrics.get('sandbox'), deps.metrics.get('sandbox')]);
    expect(repo.metrics).toHaveBeenCalledTimes(1);
    expect((await deps.metrics.get('sandbox')).source).toBe('memory');
    await deps.metrics.get('other');
    tick(5000);
    await deps.metrics.get('sandbox');
    expect(repo.metrics).toHaveBeenCalledTimes(3);
  });
  it('redacts credentials, cookies and descriptions in structured logs', () => {
    let output = '';
    const stream = new Writable({ write(chunk, _, done) { output += chunk.toString(); done(); } });
    const logger = createLogger(stream).child({ correlationId: 'test' });
    logger.info({ authorization: 'secret-token', cookies: 'secret-cookie', body: { description: 'private-description' }, req: { method: 'POST', headers: { authorization: 'secret-auth', cookie: 'private-cookie' } } });
    expect(output).not.toMatch(/secret-|private-/);
    expect(JSON.parse(output).correlationId).toBe('test');
  });
});
