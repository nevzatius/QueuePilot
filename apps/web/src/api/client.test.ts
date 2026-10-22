import { describe, expect, it, vi } from 'vitest';
import { createProblem } from '@queuepilot/contracts';
import { ApiError, createApiClient } from './client';
import { RETRY_BUDGET_MS } from './coldStart';

const REQUEST_ID = '3f2b8a4e-1c5d-4e7a-9b6f-0a1b2c3d4e5f';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function setup(respond: () => Response | Promise<Response>) {
  const fetchImpl = vi.fn<typeof fetch>(async () => respond());
  const onUnauthenticated = vi.fn();
  const client = createApiClient({
    baseUrl: 'https://api.example.test',
    getToken: async () => 'tok-123',
    fetchImpl,
    onUnauthenticated,
  });
  return { client, fetchImpl, onUnauthenticated };
}

function lastCall(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [url, init] = fetchImpl.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
}

describe('api client', () => {
  it('sends the bearer token and parses /me', async () => {
    const { client, fetchImpl } = setup(() => jsonResponse({ uid: 'u1', email: 'a@example.test', membership: null }));
    await expect(client.me()).resolves.toEqual({ uid: 'u1', email: 'a@example.test', membership: null });
    const { url, headers } = lastCall(fetchImpl);
    expect(url).toBe('https://api.example.test/api/v1/me');
    expect(headers['authorization']).toBe('Bearer tok-123');
  });

  it('posts a request with the Idempotency-Key header and reports replays', async () => {
    const body = { requestId: REQUEST_ID, location: `/api/v1/requests/${REQUEST_ID}` };
    const { client, fetchImpl } = setup(() => jsonResponse(body, { status: 202, headers: { 'idempotent-replayed': 'true' } }));
    const result = await client.createRequest({ type: 'general', title: 'Hello world' }, 'key-12345678');
    expect(result).toEqual({ ...body, replayed: true });
    const { init, headers } = lastCall(fetchImpl);
    expect(init.method).toBe('POST');
    expect(headers['idempotency-key']).toBe('key-12345678');
    expect(JSON.parse(init.body as string)).toEqual({ type: 'general', title: 'Hello world' });
  });

  it('marks a first creation as not replayed', async () => {
    const { client } = setup(() => jsonResponse({ requestId: REQUEST_ID, location: '/x' }, { status: 202 }));
    expect((await client.createRequest({ type: 'general', title: 'Hello' }, 'key-12345678')).replayed).toBe(false);
  });

  it('builds list queries from scope, limit and cursor', async () => {
    const { client, fetchImpl } = setup(() => jsonResponse({ items: [], nextCursor: null }));
    await client.listRequests({ scope: 'mine', limit: 20, cursor: 'abc_1' });
    expect(lastCall(fetchImpl).url).toBe('https://api.example.test/api/v1/requests?scope=mine&limit=20&cursor=abc_1');
  });

  it('turns Problem Details into an ApiError with code and correlation id', async () => {
    const problem = createProblem({ code: 'QUOTA_UNAVAILABLE', correlationId: 'corr-1', retryAfterSeconds: 7 });
    const { client } = setup(() => jsonResponse(problem, { status: 503 }));
    const error = await client.getMetrics().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'problem', status: 503, code: 'QUOTA_UNAVAILABLE', correlationId: 'corr-1', retryAfterSeconds: 7 });
  });

  it('signals an expired session on 401', async () => {
    const problem = createProblem({ code: 'UNAUTHENTICATED', correlationId: 'corr-2' });
    const { client, onUnauthenticated } = setup(() => jsonResponse(problem, { status: 401 }));
    await expect(client.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(onUnauthenticated).toHaveBeenCalledOnce();
  });

  it('reports network failures without a status once the retry budget is spent', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup(() => Promise.reject(new TypeError('failed to fetch')));
      const result = client.me().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(RETRY_BUDGET_MS * 2);
      await expect(result).resolves.toMatchObject({ kind: 'network', status: null, code: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects responses that violate the contract', async () => {
    const { client } = setup(() => jsonResponse({ unexpected: true }));
    await expect(client.me()).rejects.toMatchObject({ kind: 'unexpected' });
  });

  it('treats a non-problem error body as unexpected', async () => {
    const { client } = setup(() => new Response('<html>not found</html>', { status: 404 }));
    await expect(client.me()).rejects.toMatchObject({ kind: 'unexpected', status: 404, code: null });
  });
});
