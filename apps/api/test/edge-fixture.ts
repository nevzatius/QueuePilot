import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { AdmissionControl, ApiError, loadConfig, MembershipService, MemoryRateLimiter, MetricsService } from '@queuepilot/core';
import type { RateLimiter, RequestRepository, Tenant } from '@queuepilot/core';
import { buildApp } from '../src/app.js';

const tenant: Tenant = { name: 'Sandbox', status: 'active', openSignup: true, quotaMode: 'none', schemaVersion: 1,
  limits: { submitPerMin: 1000, submitPerDayUser: 30, submitPerDayTenant: 2000 } };

/** A small API for edge behaviour (CORS, client IP): real app wiring, fake dependencies. `env` goes through loadConfig. */
export function edgeApp(env: Record<string, string> = {}, bootstrapLimiter?: RateLimiter) {
  const clock = { now: () => 1000 };
  const store = {
    member: vi.fn(async () => ({ tenantId: 'sandbox', role: 'member' as const, status: 'active' as const, schemaVersion: 1 as const })),
    tenant: vi.fn(async () => ({ ...tenant })), bootstrap: vi.fn(async () => true),
  };
  const repo: RequestRepository = {
    submit: vi.fn(async () => ({ requestId: randomUUID(), replayed: false })),
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    detail: vi.fn(async () => { throw new ApiError('NOT_FOUND'); }),
    metrics: vi.fn<RequestRepository['metrics']>(async (tenantId) => ({ tenantId, generatedAt: new Date(1000).toISOString(), source: 'firestore',
      counts: { ACCEPTED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 }, stuck: 0 })),
    backlog: vi.fn(async () => 0), health: vi.fn(async () => {}),
  };
  const verifier = { verify: vi.fn(async (token: string) => {
    if (token !== 'valid') throw new ApiError('UNAUTHENTICATED');
    return { uid: 'alice', email: null };
  }) };
  const app = buildApp({ config: loadConfig({ QP_ENV: 'test', ...env }), verifier, memberships: new MembershipService(store, clock), requests: repo,
    queue: { enqueue: vi.fn(async () => {}) }, admission: new AdmissionControl(clock), metrics: new MetricsService(repo, clock),
    rateLimiter: new MemoryRateLimiter(clock, 1), ...(bootstrapLimiter ? { bootstrapLimiter } : {}), logger: false });
  return { app, verifier, repo };
}
