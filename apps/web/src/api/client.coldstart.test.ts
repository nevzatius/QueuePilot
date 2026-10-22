import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProblem } from '@queuepilot/contracts';
import { createApiClient } from './client';
import {
  ATTEMPT_TIMEOUT_MS,
  RETRY_BACKOFF_MAX_MS,
  RETRY_BACKOFF_START_MS,
  RETRY_BUDGET_MS,
  SLOW_RESPONSE_NOTICE_MS,
} from './coldStart';

const REQUEST_ID = '3f2b8a4e-1c5d-4e7a-9b6f-0a1b2c3d4e5f';
const ME = { uid: 'u1', email: 'a@example.test', membership: null };

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const html503 = () => new Response('<html>Service Unavailable</html>', { status: 503 });

type Step = () => Response | Promise<Response>;
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function setup(steps: Step[], baseUrl = 'https://api.example.test') {
  let i = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => (steps[Math.min(i++, steps.length - 1)] as Step)());
  const onWakingChange = vi.fn();
  const client = createApiClient({ baseUrl, getToken: async () => 'tok-123', fetchImpl, onWakingChange });
  return { client, fetchImpl, onWakingChange };
}

const init = (fetchImpl: FetchMock, n: number) => fetchImpl.mock.calls[n]![1] as RequestInit;
const headers = (fetchImpl: FetchMock, n: number) => init(fetchImpl, n).headers as Record<string, string>;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('cross-origin requests', () => {
  it('sends the bearer token, omits credentials and builds URLs without a double slash', async () => {
    const { client, fetchImpl } = setup([() => json(ME)], 'https://api.example.test/');
    await client.me();
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.example.test/api/v1/me');
    expect(headers(fetchImpl, 0)['authorization']).toBe('Bearer tok-123');
    expect(init(fetchImpl, 0).credentials).toBe('omit');
  });

  it('reads only response headers that the API exposes through CORS', async () => {
    // Mirror of CORS_EXPOSED_HEADERS in apps/api/src/cors.ts (that list is asserted by apps/api/test/cors.test.ts).
    const exposed = ['retry-after', 'idempotent-replayed', 'x-correlation-id', 'location'];
    const body = { requestId: REQUEST_ID, location: `/api/v1/requests/${REQUEST_ID}` };
    const read: string[] = [];
    const res = json(body, { status: 202, headers: { 'idempotent-replayed': 'true' } });
    const realGet = res.headers.get.bind(res.headers);
    vi.spyOn(res.headers, 'get').mockImplementation((name: string) => {
      read.push(name.toLowerCase());
      return realGet(name);
    });
    const { client } = setup([() => res]);
    await client.createRequest({ type: 'general', title: 'Hello' }, 'key-12345678');
    expect(read.length).toBeGreaterThan(0);
    for (const name of read) expect(exposed).toContain(name);
  });
});

describe('cold start', () => {
  it('shows the waking state on a platform 503 and clears it on success', async () => {
    const { client, fetchImpl, onWakingChange } = setup([html503, html503, () => json(ME)]);
    const p = client.me();
    await vi.advanceTimersByTimeAsync(0);
    expect(onWakingChange).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_START_MS * 3);
    await expect(p).resolves.toEqual(ME);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onWakingChange.mock.calls).toEqual([[true], [false]]);
  });

  it('retries a network error and 502/504', async () => {
    const { client, fetchImpl } = setup([
      () => Promise.reject(new TypeError('failed to fetch')),
      () => new Response('bad gateway', { status: 502 }),
      () => new Response('timeout', { status: 504 }),
      () => json(ME),
    ]);
    const p = client.me();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toEqual(ME);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('shows the waking state for a slow response without retrying, then clears it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client, fetchImpl, onWakingChange } = setup([
      async () => {
        await gate;
        return json(ME);
      },
    ]);
    const p = client.me();
    await vi.advanceTimersByTimeAsync(SLOW_RESPONSE_NOTICE_MS - 1);
    expect(onWakingChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onWakingChange).toHaveBeenLastCalledWith(true);
    release();
    await expect(p).resolves.toEqual(ME);
    expect(onWakingChange).toHaveBeenLastCalledWith(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up within the retry budget with the last error and clears the waking state', async () => {
    const { client, fetchImpl, onWakingChange } = setup([html503]);
    const p = client.me().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_MS + RETRY_BACKOFF_MAX_MS);
    await expect(p).resolves.toMatchObject({ kind: 'unexpected', status: 503 });
    // 2 + 4 + 8 s, then 10 s steps up to the budget: 11 attempts. Bounded, not unlimited.
    expect(fetchImpl).toHaveBeenCalledTimes(11);
    expect(onWakingChange).toHaveBeenLastCalledWith(false);
  });

  it('a manual retry after giving up is a fresh call with a fresh budget', async () => {
    const { client, fetchImpl } = setup([html503]);
    const first = client.me().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RETRY_BUDGET_MS + RETRY_BACKOFF_MAX_MS);
    await first;
    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async () => json(ME));
    await expect(client.me()).resolves.toEqual(ME);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts an attempt that hangs past the attempt timeout and treats it as a network failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const client = createApiClient({ baseUrl: 'https://api.example.test', getToken: async () => 't', fetchImpl });
    const p = client.me().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS + RETRY_BUDGET_MS);
    await expect(p).resolves.toMatchObject({ kind: 'network' });
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not treat an API Problem Details 503 as a wake-up', async () => {
    const problem = createProblem({ code: 'QUOTA_UNAVAILABLE', correlationId: 'c-1', retryAfterSeconds: 7 });
    const { client, fetchImpl, onWakingChange } = setup([() => json(problem, { status: 503 })]);
    await expect(client.me()).rejects.toMatchObject({ code: 'QUOTA_UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onWakingChange).not.toHaveBeenCalled();
  });
});

describe('retry safety', () => {
  const create = (c: ReturnType<typeof setup>['client']) => c.createRequest({ type: 'general', title: 'Hello' }, 'key-12345678');
  const accepted = () => json({ requestId: REQUEST_ID, location: '/x' }, { status: 202 });

  it('reuses the same Idempotency-Key and body when a POST is retried', async () => {
    const { client, fetchImpl } = setup([html503, () => Promise.reject(new TypeError('x')), accepted]);
    const p = create(client);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toMatchObject({ requestId: REQUEST_ID });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (let n = 0; n < 3; n++) {
      expect(headers(fetchImpl, n)['idempotency-key']).toBe('key-12345678');
      expect(init(fetchImpl, n).body).toBe(init(fetchImpl, 0).body);
    }
  });

  it('never retries a write that carries no Idempotency-Key', async () => {
    const { client, fetchImpl } = setup([html503, () => json({ membership: null })]);
    await expect(client.bootstrap()).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 409, 422, 429, 500])('does not retry a %i answer', async (status) => {
    const problem = createProblem({ code: 'VALIDATION_FAILED', correlationId: 'c-1' });
    const get = setup([() => json(problem, { status })]);
    await expect(get.client.me()).rejects.toMatchObject({ status });
    expect(get.fetchImpl).toHaveBeenCalledTimes(1);
    const post = setup([() => json(problem, { status })]);
    await expect(create(post.client)).rejects.toMatchObject({ status });
    expect(post.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 4xx without a Problem Details body either', async () => {
    const { client, fetchImpl } = setup([() => new Response('nope', { status: 404 })]);
    await expect(client.me()).rejects.toMatchObject({ kind: 'unexpected', status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
