import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { createProblem, type Membership, type RequestDetail, type RequestSummary } from '@queuepilot/contracts';
import { App } from './App';
import { ApiError, type ApiClient } from './api/client';
import type { AuthAdapter, AuthUser } from './auth/AuthContext';

const USER: AuthUser = { uid: 'u1', email: 'user@example.test', displayName: null };
const REQUEST_ID = '3f2b8a4e-1c5d-4e7a-9b6f-0a1b2c3d4e5f';
const MEMBER: Membership = { tenantId: 'sandbox', tenantName: 'Test Workspace', tenantStatus: 'active', role: 'member', status: 'active' };

function adapter(signedIn: boolean): AuthAdapter {
  let user = signedIn ? USER : null;
  const listeners = new Set<(u: AuthUser | null) => void>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      cb(user);
      return () => listeners.delete(cb);
    },
    async signIn() {
      user = USER;
      listeners.forEach((l) => l(user));
    },
    async signOut() {
      user = null;
      listeners.forEach((l) => l(user));
    },
    getIdToken: async () => 'tok',
  };
}

function problem(code: Parameters<typeof createProblem>[0]['code'], extra: { retryAfterSeconds?: number } = {}) {
  const p = createProblem({ code, correlationId: 'corr-42', ...extra });
  return new ApiError('problem', p.status, p, p.title);
}

function summary(over: Partial<RequestSummary> = {}): RequestSummary {
  return {
    requestId: REQUEST_ID,
    type: 'general',
    title: 'Flat tyre on the ring road',
    priority: 'normal',
    status: 'ACCEPTED',
    attempts: 0,
    createdAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
    ...over,
  };
}

function client(over: Partial<ApiClient> = {}): ApiClient {
  return {
    me: vi.fn(async () => ({ uid: USER.uid, email: USER.email, membership: MEMBER })),
    bootstrap: vi.fn(async () => ({ created: true, membership: MEMBER })),
    createRequest: vi.fn(async () => ({ requestId: REQUEST_ID, location: '/x', replayed: false })),
    listRequests: vi.fn(async () => ({ items: [], nextCursor: null })),
    getRequest: vi.fn(async () => {
      throw problem('NOT_FOUND');
    }),
    getMetrics: vi.fn(async () => ({
      tenantId: 'sandbox',
      generatedAt: '2026-10-19T10:00:00.000Z',
      source: 'memory' as const,
      counts: { ACCEPTED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0 },
      stuck: 0,
    })),
    ...over,
  };
}

function renderApp(api: ApiClient, opts: { signedIn?: boolean; path?: string } = {}) {
  return render(
    <MemoryRouter initialEntries={[opts.path ?? '/requests']}>
      <App adapter={adapter(opts.signedIn ?? true)} createClient={() => api} />
    </MemoryRouter>,
  );
}

describe('authentication and session', () => {
  it('shows the Google sign-in screen when signed out and enters the app after sign-in', async () => {
    renderApp(client(), { signedIn: false });
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    expect(await screen.findByRole('heading', { name: 'My requests' })).toBeInTheDocument();
  });

  it('asks a user without membership to join, then bootstraps', async () => {
    const api = client({ me: vi.fn(async () => ({ uid: 'u1', email: null, membership: null })) });
    renderApp(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Join workspace' }));
    expect(api.bootstrap).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: 'My requests' })).toBeInTheDocument();
  });

  it('shows SIGNUP_CLOSED when bootstrap is refused', async () => {
    const api = client({
      me: vi.fn(async () => ({ uid: 'u1', email: null, membership: null })),
      bootstrap: vi.fn(async () => {
        throw problem('SIGNUP_CLOSED');
      }),
    });
    renderApp(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Join workspace' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-up is closed');
  });

  it('blocks suspended memberships', async () => {
    const api = client({
      me: vi.fn(async () => ({ uid: 'u1', email: null, membership: { ...MEMBER, status: 'suspended' as const } })),
    });
    renderApp(api);
    expect(await screen.findByText(/membership is suspended/i, { selector: 'p' })).toBeInTheDocument();
  });

  it('re-checks the session when a call answers ONBOARDING_REQUIRED', async () => {
    const me = vi
      .fn()
      .mockResolvedValueOnce({ uid: 'u1', email: null, membership: MEMBER })
      .mockResolvedValue({ uid: 'u1', email: null, membership: null });
    const api = client({
      me,
      listRequests: vi.fn(async () => {
        throw problem('ONBOARDING_REQUIRED');
      }),
    });
    renderApp(api);
    expect(await screen.findByRole('button', { name: 'Join workspace' })).toBeInTheDocument();
  });
});

describe('request list', () => {
  it('shows the empty state', async () => {
    renderApp(client());
    expect(await screen.findByText('No requests yet')).toBeInTheDocument();
  });

  it('shows an error with its correlation id and can retry', async () => {
    const listRequests = vi
      .fn<ApiClient['listRequests']>()
      .mockRejectedValueOnce(problem('SERVICE_UNAVAILABLE'))
      .mockResolvedValue({ items: [summary()], nextCursor: null });
    renderApp(client({ listRequests }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Reference: corr-42');
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect((await screen.findAllByText('Flat tyre on the ring road')).length).toBeGreaterThan(0);
  });

  it('derives Queued and Retrying from ACCEPTED and attempts', async () => {
    const listRequests = vi.fn(async () => ({
      items: [
        summary({ requestId: REQUEST_ID, title: 'First', attempts: 0 }),
        summary({ requestId: '4a2b8a4e-1c5d-4e7a-9b6f-0a1b2c3d4e5f', title: 'Second', attempts: 2 }),
      ],
      nextCursor: null,
    }));
    renderApp(client({ listRequests }));
    await screen.findAllByText('First');
    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Retrying').length).toBeGreaterThan(0);
  });

  it('hides tenant-wide actions from members and shows them to admins', async () => {
    const { unmount } = renderApp(client());
    await screen.findByText('No requests yet');
    expect(screen.queryByRole('button', { name: 'All tenant requests' })).not.toBeInTheDocument();
    unmount();

    const admin = client({ me: vi.fn(async () => ({ uid: 'u1', email: null, membership: { ...MEMBER, role: 'admin' as const } })) });
    renderApp(admin);
    expect(await screen.findByRole('button', { name: 'All tenant requests' })).toBeInTheDocument();
  });

  it('never requests the tenant scope for a member, even via the URL', async () => {
    const api = client();
    renderApp(api, { path: '/requests?scope=tenant' });
    await screen.findByText('No requests yet');
    expect(api.listRequests).toHaveBeenCalledWith(expect.objectContaining({ scope: 'mine' }));
    expect(api.listRequests).not.toHaveBeenCalledWith(expect.objectContaining({ scope: 'tenant' }));
  });
});

describe('new request form', () => {
  it('validates the title before calling the API', async () => {
    const api = client();
    renderApp(api, { path: '/requests/new' });
    await userEvent.click(await screen.findByRole('button', { name: 'Submit request' }));
    expect(await screen.findByText(/too small|at least 3/i)).toBeInTheDocument();
    expect(api.createRequest).not.toHaveBeenCalled();
  });

  it('reuses the idempotency key when retrying an unchanged form after QUOTA_UNAVAILABLE', async () => {
    const createRequest = vi
      .fn<ApiClient['createRequest']>()
      .mockRejectedValueOnce(problem('QUOTA_UNAVAILABLE', { retryAfterSeconds: 5 }))
      .mockResolvedValue({ requestId: REQUEST_ID, location: '/x', replayed: false });
    renderApp(client({ createRequest }), { path: '/requests/new' });

    await userEvent.type(await screen.findByLabelText('Title'), 'Battery is dead');
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your request was not accepted');
    expect(screen.getByRole('alert')).toHaveTextContent('Retry in about 5 s');

    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(await screen.findByText(/Request accepted/)).toBeInTheDocument();

    const [first, second] = createRequest.mock.calls;
    expect(first?.[1]).toBe(second?.[1]);
  });

  it('uses a new key after the form changed', async () => {
    const createRequest = vi
      .fn<ApiClient['createRequest']>()
      .mockRejectedValueOnce(problem('OVERLOADED'))
      .mockResolvedValue({ requestId: REQUEST_ID, location: '/x', replayed: false });
    renderApp(client({ createRequest }), { path: '/requests/new' });
    const title = await screen.findByLabelText('Title');
    await userEvent.type(title, 'First try');
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await screen.findByRole('alert');
    await userEvent.type(title, ' edited');
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await screen.findByText(/Request accepted/);
    expect(createRequest.mock.calls[0]?.[1]).not.toBe(createRequest.mock.calls[1]?.[1]);
  });

  it('maps server validation pointers onto fields', async () => {
    const p = createProblem({ code: 'VALIDATION_FAILED', correlationId: 'c', errors: [{ pointer: '/title', message: 'Title rejected by server' }] });
    const createRequest = vi.fn(async () => {
      throw new ApiError('problem', 400, p, p.title);
    });
    renderApp(client({ createRequest }), { path: '/requests/new' });
    await userEvent.type(await screen.findByLabelText('Title'), 'Valid title');
    await userEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(await screen.findByText('Title rejected by server')).toBeInTheDocument();
  });
});

describe('request detail', () => {
  const detail: RequestDetail = {
    ...summary({
      status: 'COMPLETED',
      attempts: 1,
      completedAt: '2026-10-19T10:00:09.000Z',
      result: { rulesVersion: 'v1', lane: 'emergency', slaTargetMinutes: 90, team: 'team-a', score: 80 },
    }),
    tenantId: 'sandbox',
    createdBy: 'u1',
    description: 'Left rear tyre',
    attributes: { safetyRisk: true },
    source: 'ui',
    correlationId: 'corr-detail',
    maxAttempts: 3,
    duplicateDeliveries: 0,
    events: [
      { type: 'ACCEPTED', at: '2026-10-19T10:00:00.000Z', actor: 'api', attempt: 0, seq: 1 },
      { type: 'COMPLETED', at: '2026-10-19T10:00:09.000Z', actor: 'worker', attempt: 1, seq: 1 },
    ],
  };

  it('renders the triage result and the timeline', async () => {
    renderApp(client({ getRequest: vi.fn(async () => detail) }), { path: `/requests/${REQUEST_ID}` });
    expect(await screen.findByRole('heading', { name: 'Triage result' })).toBeInTheDocument();
    expect(screen.getByText('Emergency')).toBeInTheDocument();
    expect(screen.getByText('1 h 30 min')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('heading', { name: 'Timeline' })).toBeInTheDocument();
  });

  it('shows a not-found state', async () => {
    renderApp(client(), { path: `/requests/${REQUEST_ID}` });
    await waitFor(() => expect(screen.getByText(/does not exist or you cannot see it/)).toBeInTheDocument());
  });
});

describe('metrics', () => {
  it('shows counts and the stuck indicator', async () => {
    const getMetrics = vi.fn(async () => ({
      tenantId: 'sandbox',
      generatedAt: '2026-10-19T10:00:00.000Z',
      source: 'redis' as const,
      counts: { ACCEPTED: 4, PROCESSING: 2, COMPLETED: 10, FAILED: 1 },
      stuck: 3,
    }));
    renderApp(client({ getMetrics }), { path: '/metrics' });
    expect(await screen.findByText('10')).toBeInTheDocument();
    expect(screen.getByText('Stuck')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows an empty state when nothing was recorded', async () => {
    renderApp(client(), { path: '/metrics' });
    expect(await screen.findByText(/No requests have been recorded/)).toBeInTheDocument();
  });
});
