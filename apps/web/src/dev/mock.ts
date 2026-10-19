/**
 * DEVELOPMENT ONLY. In-memory stand-in for the API and Google sign-in, enabled by
 * `VITE_USE_MOCK_API=true` in `vite dev`. It is dynamically imported behind `import.meta.env.DEV`, so
 * it is not part of production bundles. The data is synthetic; the triage values below are placeholders
 * and are NOT the real rule table (ARCHITECTURE §17). Delete once B3 serves the real API.
 */
import {
  CreateRequestBodySchema,
  createProblem,
  type CreateRequestInput,
  type MetricsResponse,
  type RequestDetail,
  type RequestSummary,
} from '@queuepilot/contracts';
import { ApiError, type ApiClient, type CreateRequestResult } from '../api/client';
import type { AuthAdapter, AuthUser } from '../auth/AuthContext';

const MOCK_USER: AuthUser = { uid: 'mock-user-1', email: 'dev.user@example.test', displayName: 'Dev User' };

export function createMockAuth(): AuthAdapter {
  let user: AuthUser | null = null;
  const listeners = new Set<(u: AuthUser | null) => void>();
  const emit = () => listeners.forEach((l) => l(user));
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      onChange(user);
      return () => listeners.delete(onChange);
    },
    async signIn() {
      user = MOCK_USER;
      emit();
    },
    async signOut() {
      user = null;
      emit();
    },
    async getIdToken() {
      return 'mock-token';
    },
  };
}

interface Stored {
  id: string;
  body: ReturnType<typeof CreateRequestBodySchema.parse>;
  createdAt: number;
}

const PROCESSING_AFTER_MS = 4_000;
const DONE_AFTER_MS = 9_000;

export function createMockApi(opts: { admin?: boolean } = {}): ApiClient {
  const requests: Stored[] = [];
  const keys = new Map<string, { id: string; fingerprint: string }>();
  let member = false;
  const membership = () => ({
    tenantId: 'sandbox',
    tenantName: 'Sandbox (mock)',
    tenantStatus: 'active' as const,
    role: opts.admin ? ('admin' as const) : ('member' as const),
    status: 'active' as const,
  });
  const iso = (ms: number) => new Date(ms).toISOString();

  function view(r: Stored): RequestDetail {
    const age = Date.now() - r.createdAt;
    const status = age >= DONE_AFTER_MS ? 'COMPLETED' : age >= PROCESSING_AFTER_MS ? 'PROCESSING' : 'ACCEPTED';
    const events: RequestDetail['events'] = [{ type: 'ACCEPTED', at: iso(r.createdAt), actor: 'api', attempt: 0, seq: 1 }];
    if (status !== 'ACCEPTED') {
      events.push({ type: 'PROCESSING_STARTED', at: iso(r.createdAt + PROCESSING_AFTER_MS), actor: 'worker', attempt: 1, seq: 1 });
    }
    if (status === 'COMPLETED') {
      events.push({ type: 'COMPLETED', at: iso(r.createdAt + DONE_AFTER_MS), actor: 'worker', attempt: 1, seq: 1 });
    }
    return {
      requestId: r.id,
      type: r.body.type,
      title: r.body.title,
      priority: r.body.priority,
      status,
      attempts: status === 'ACCEPTED' ? 0 : 1,
      createdAt: iso(r.createdAt),
      updatedAt: iso(status === 'COMPLETED' ? r.createdAt + DONE_AFTER_MS : r.createdAt),
      ...(status === 'COMPLETED' && {
        completedAt: iso(r.createdAt + DONE_AFTER_MS),
        result: { rulesVersion: 'mock-0', lane: 'standard', slaTargetMinutes: 60, team: 'mock-team', score: 50 },
      }),
      ...(status !== 'ACCEPTED' && { startedAt: iso(r.createdAt + PROCESSING_AFTER_MS) }),
      tenantId: 'sandbox',
      createdBy: MOCK_USER.uid,
      description: r.body.description,
      attributes: r.body.attributes,
      source: 'ui',
      correlationId: `mock-${r.id.slice(0, 8)}`,
      maxAttempts: 3,
      duplicateDeliveries: 0,
      events,
    };
  }

  const summary = (d: RequestDetail): RequestSummary => ({
    requestId: d.requestId,
    type: d.type,
    title: d.title,
    priority: d.priority,
    status: d.status,
    attempts: d.attempts,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(d.completedAt !== undefined && { completedAt: d.completedAt }),
    ...(d.result !== undefined && { result: d.result }),
  });

  const ordered = () => [...requests].sort((a, b) => b.createdAt - a.createdAt);
  const requireMember = () => {
    if (!member) {
      throw new ApiError('problem', 403, createProblem({ code: 'ONBOARDING_REQUIRED', correlationId: 'mock' }), 'Onboarding required');
    }
  };

  return {
    async me() {
      return { uid: MOCK_USER.uid, email: MOCK_USER.email, membership: member ? membership() : null };
    },
    async bootstrap() {
      const created = !member;
      member = true;
      return { created, membership: membership() };
    },
    async createRequest(input: CreateRequestInput, key: string): Promise<CreateRequestResult> {
      requireMember();
      const parsed = CreateRequestBodySchema.safeParse(input);
      if (!parsed.success) {
        throw new ApiError(
          'problem',
          400,
          createProblem({
            code: 'VALIDATION_FAILED',
            correlationId: 'mock',
            errors: parsed.error.issues.map((i) => ({ pointer: `/${i.path.join('/')}`, message: i.message })),
          }),
          'Validation failed',
        );
      }
      const fingerprint = JSON.stringify(parsed.data);
      const existing = keys.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new ApiError('problem', 409, createProblem({ code: 'IDEMPOTENCY_KEY_REUSED', correlationId: 'mock' }), 'Conflict');
        }
        return { requestId: existing.id, location: `/api/v1/requests/${existing.id}`, replayed: true };
      }
      const id = crypto.randomUUID();
      requests.push({ id, body: parsed.data, createdAt: Date.now() });
      keys.set(key, { id, fingerprint });
      return { requestId: id, location: `/api/v1/requests/${id}`, replayed: false };
    },
    async listRequests(params = {}) {
      requireMember();
      const limit = params.limit ?? 20;
      const all = ordered().map(view).map(summary);
      const start = params.cursor ? Number(params.cursor.replace('c', '')) : 0;
      const items = all.slice(start, start + limit);
      const next = start + limit < all.length ? `c${start + limit}` : null;
      return { items, nextCursor: next };
    },
    async getRequest(requestId) {
      requireMember();
      const found = requests.find((r) => r.id === requestId);
      if (!found) throw new ApiError('problem', 404, createProblem({ code: 'NOT_FOUND', correlationId: 'mock' }), 'Not found');
      return view(found);
    },
    async getMetrics(): Promise<MetricsResponse> {
      requireMember();
      const counts = { ACCEPTED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 };
      for (const r of requests) counts[view(r).status as keyof typeof counts]++;
      return { tenantId: 'sandbox', generatedAt: iso(Date.now()), source: 'memory', counts, stuck: 0 };
    },
  };
}
