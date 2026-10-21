import { randomUUID } from 'node:crypto';
import util from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createLogger, LocalDispatchQueue, parseRetryAfter, QSTASH_PUBLISH_TIMEOUT_MS, QStashQueue, QueueEnqueueError } from '@queuepilot/core';
import type { QStashFetch, QStashQueueConfig, QStashResponse } from '@queuepilot/core';

// Recognisable fake; every error path below must not contain it.
const TOKEN = 'FAKE-qstash-token-7f3a91';
const WORKER = 'https://qp-worker.example.test';
const config: QStashQueueConfig = { token: TOKEN, baseUrl: 'https://qstash.upstash.io', workerUrl: WORKER, retries: 2, timeout: '90s' };
const clock = { now: () => Date.UTC(2026, 9, 21, 12, 0, 0) };
const payload = () => ({ requestId: randomUUID(), tenantId: 'test-queue', seq: 1, correlationId: randomUUID() });
const signal = () => new AbortController().signal;

const respond = (status: number, body = '', headers: Record<string, string> = {}): QStashResponse => ({
  status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => body,
});
function fixture(send: QStashFetch, overrides: Partial<QStashQueueConfig> = {}) {
  const lines: string[] = [];
  const log = createLogger({ write: (line: string) => { lines.push(line); } });
  return { queue: new QStashQueue({ ...config, ...overrides }, log, clock, send), lines };
}
const replying = (response: QStashResponse) => vi.fn<QStashFetch>(async () => response);
const surfaces = (error: unknown, lines: string[]) => [
  util.inspect(error, { depth: null, showHidden: true }), String((error as Error).message), (error as Error).stack ?? '', ...lines,
];

describe('QStashQueue publish request', () => {
  it('posts the payload to the worker dispatch URL with the documented headers', async () => {
    const send = replying(respond(201, '{"messageId":"msg_1"}'));
    const p = payload();
    await fixture(send).queue.enqueue(p, signal());
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe(`https://qstash.upstash.io/v2/publish/${WORKER}/internal/tasks`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(JSON.parse(init.body)).toEqual(p);
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Upstash-Deduplication-Id': `r-${p.requestId}-1`, // the Cloud Tasks task name suffix
      'Upstash-Retries': '2',
      'Upstash-Timeout': '90s',
    });
  });

  it('derives the deduplication id exactly like the Cloud Tasks task name, per seq', async () => {
    const send = replying(respond(201));
    const { queue } = fixture(send);
    const p = payload();
    await queue.enqueue(p, signal());
    await queue.enqueue({ ...p, seq: 2 }, signal());
    expect(send.mock.calls.map(([, init]) => init.headers['Upstash-Deduplication-Id'])).toEqual([`r-${p.requestId}-1`, `r-${p.requestId}-2`]);
  });

  it('sends the configured retries and the timeout with its unit', async () => {
    const send = replying(respond(201));
    await fixture(send, { retries: 0, timeout: '1m30s' }).queue.enqueue(payload(), signal());
    expect(send.mock.calls[0]![1].headers).toMatchObject({ 'Upstash-Retries': '0', 'Upstash-Timeout': '1m30s' });
  });

  it('keeps the token in the Authorization header only', async () => {
    const send = replying(respond(201));
    await fixture(send).queue.enqueue(payload(), signal());
    const [url, init] = send.mock.calls[0]!;
    expect(url).not.toContain(TOKEN);
    expect(init.body).not.toContain(TOKEN);
    for (const [name, value] of Object.entries(init.headers)) {
      if (name !== 'Authorization') expect(value).not.toContain(TOKEN);
    }
  });

  it('uses the regional base URL it is given', async () => {
    const send = replying(respond(201));
    await fixture(send, { baseUrl: 'https://qstash-eu-central-1.upstash.io' }).queue.enqueue(payload(), signal());
    expect(send.mock.calls[0]![0]).toMatch(/^https:\/\/qstash-eu-central-1\.upstash\.io\/v2\/publish\//);
  });

  it('forwards no extra headers: the worker contract needs none', async () => {
    const send = replying(respond(201));
    await fixture(send).queue.enqueue(payload(), signal());
    expect(Object.keys(send.mock.calls[0]![1].headers).filter((name) => name.startsWith('Upstash-Forward-'))).toEqual([]);
  });
});

describe('QStashQueue response mapping', () => {
  type Success = { outcome: 'CREATED' | 'DEDUPLICATED'; messageId?: string };
  const successes: Array<[string, QStashResponse, Success]> = [
    ['201 with a messageId', respond(201, '{"messageId":"msg_1"}'), { outcome: 'CREATED', messageId: 'msg_1' }],
    ['201 with deduplicated:false', respond(201, '{"messageId":"msg_1","deduplicated":false}'), { outcome: 'CREATED', messageId: 'msg_1' }],
    ['201 with an empty body', respond(201), { outcome: 'CREATED' }],
    ['201 with a body that is not JSON', respond(201, 'created'), { outcome: 'CREATED' }],
    ['201 with deduplicated:true (measured on the real service)', respond(201, '{"messageId":"msg_1","deduplicated":true}'), { outcome: 'DEDUPLICATED', messageId: 'msg_1' }],
    ['202 with a messageId (documented duplicate status)', respond(202, '{"messageId":"msg_1"}'), { outcome: 'CREATED', messageId: 'msg_1' }],
    ['200 with a messageId', respond(200, '{"messageId":"msg_1"}'), { outcome: 'CREATED', messageId: 'msg_1' }],
  ];
  it.each(successes)('%s is a success', async (_label, response, expected) => {
    await expect(fixture(replying(response)).queue.publish(payload(), signal())).resolves.toEqual(expected);
    await expect(fixture(replying(response)).queue.enqueue(payload(), signal())).resolves.toBeUndefined();
  });

  it('201 with "deduplicated":true is CREATED for the caller, like ALREADY_EXISTS', async () => {
    const send = replying(respond(201, '{"messageId":"msg_1","deduplicated":true}'));
    const { queue, lines } = fixture(send);
    await expect(queue.enqueue(payload(), signal())).resolves.toBeUndefined();
    expect(await queue.publish(payload(), signal())).toMatchObject({ outcome: 'DEDUPLICATED' });
    expect(lines).toEqual([]);
  });

  type Failure = { code: string; failureClass: 'permanent' | 'quota' | 'transient'; status?: number; retryAfterSeconds?: number };
  const failures: Array<[string, QStashResponse, Failure]> = [
    ['200 without a messageId', respond(200, '{}'), { code: 'UNKNOWN', failureClass: 'transient', status: 200 }],
    ['200 with an empty body', respond(200), { code: 'UNKNOWN', failureClass: 'transient', status: 200 }],
    ['202 without a messageId', respond(202, '{"deduplicated":true}'), { code: 'UNKNOWN', failureClass: 'transient', status: 202 }],
    ['204', respond(204), { code: 'UNKNOWN', failureClass: 'transient', status: 204 }],
    ['400', respond(400, '{"error":"invalid header"}'), { code: 'INVALID_ARGUMENT', failureClass: 'permanent', status: 400 }],
    ['401', respond(401, '{"error":"unauthorized"}'), { code: 'UNAUTHENTICATED', failureClass: 'permanent', status: 401 }],
    ['403', respond(403), { code: 'PERMISSION_DENIED', failureClass: 'permanent', status: 403 }],
    ['404 (wrong region or URL)', respond(404), { code: 'NOT_FOUND', failureClass: 'permanent', status: 404 }],
    ['422', respond(422), { code: 'INVALID_ARGUMENT', failureClass: 'permanent', status: 422 }],
    ['302 (redirects are not followed)', respond(302, '', { location: 'https://elsewhere.invalid' }), { code: 'INVALID_ARGUMENT', failureClass: 'permanent', status: 302 }],
    ['408', respond(408), { code: 'DEADLINE_EXCEEDED', failureClass: 'transient', status: 408 }],
    ['429 without Retry-After', respond(429), { code: 'RESOURCE_EXHAUSTED', failureClass: 'quota', status: 429 }],
    ['429 with Retry-After: 30', respond(429, '', { 'retry-after': '30' }), { code: 'RESOURCE_EXHAUSTED', failureClass: 'quota', status: 429, retryAfterSeconds: 30 }],
    ['429 with a Retry-After date', respond(429, '', { 'retry-after': 'Wed, 21 Oct 2026 12:01:00 GMT' }), { code: 'RESOURCE_EXHAUSTED', failureClass: 'quota', status: 429, retryAfterSeconds: 60 }],
    ['429 with a garbage Retry-After', respond(429, '', { 'retry-after': 'soon' }), { code: 'RESOURCE_EXHAUSTED', failureClass: 'quota', status: 429 }],
    ['429 with an absurd Retry-After', respond(429, '', { 'retry-after': '99999999' }), { code: 'RESOURCE_EXHAUSTED', failureClass: 'quota', status: 429, retryAfterSeconds: 86_400 }],
    ['500', respond(500), { code: 'UNAVAILABLE', failureClass: 'transient', status: 500 }],
    ['502', respond(502), { code: 'UNAVAILABLE', failureClass: 'transient', status: 502 }],
    ['503 with Retry-After (ignored: only 429 carries it)', respond(503, '', { 'retry-after': '5' }), { code: 'UNAVAILABLE', failureClass: 'transient', status: 503 }],
  ];
  it.each(failures)('%s', async (_label, response, expected) => {
    const { queue, lines } = fixture(replying(response));
    const p = payload();
    const error = await queue.enqueue(p, signal()).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(QueueEnqueueError);
    expect(error).toMatchObject(expected);
    expect((error as Error).message).toBe(`ENQUEUE_FAILED:${expected.code}`);
    expect(JSON.parse(lines[0]!)).toMatchObject({ code: 'ENQUEUE_FAILED', errorCode: expected.code, failureClass: expected.failureClass,
      requestId: p.requestId, seq: 1, correlationId: p.correlationId });
  });

  it('a refusal never reads its body', async () => {
    const response = respond(401, `{"error":"bad token ${TOKEN}"}`);
    const text = vi.spyOn(response, 'text');
    await expect(fixture(replying(response)).queue.enqueue(payload(), signal())).rejects.toThrow('ENQUEUE_FAILED:UNAUTHENTICATED');
    expect(text).not.toHaveBeenCalled();
  });

  it('never retries on its own: one fetch per enqueue, whatever the status', async () => {
    for (const status of [401, 429, 500]) {
      const send = replying(respond(status));
      await fixture(send).queue.enqueue(payload(), signal()).catch(() => undefined);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});

describe('QStashQueue network failures and the publish-call timeout', () => {
  it('maps a network error to a transient failure without its message', async () => {
    const { queue, lines } = fixture(async () => { throw new TypeError(`fetch failed: Bearer ${TOKEN}`, { cause: new Error(TOKEN) }); });
    const error = await queue.enqueue(payload(), signal()).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ code: 'UNAVAILABLE', failureClass: 'transient', message: 'ENQUEUE_FAILED:UNAVAILABLE' });
    expect('cause' in (error as Error)).toBe(false);
    expect(JSON.parse(lines[0]!)).toMatchObject({ errorCode: 'UNAVAILABLE', failureClass: 'transient' });
  });

  it('gives the publish call its own timeout, separate from Upstash-Timeout', async () => {
    expect(QSTASH_PUBLISH_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    expect(QSTASH_PUBLISH_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    const send: QStashFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(init.signal.reason); });
    });
    const { queue } = fixture(send, { publishTimeoutMs: 20 });
    const error = await queue.enqueue(payload(), signal()).then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ code: 'DEADLINE_EXCEEDED', failureClass: 'transient', message: 'ENQUEUE_FAILED:DEADLINE_EXCEEDED' });
  });

  it('stops before fetching when the caller already aborted, and reports it as cancelled', async () => {
    const send = replying(respond(201));
    const error = await fixture(send).queue.enqueue(payload(), AbortSignal.abort()).then(() => undefined, (e: unknown) => e);
    expect(send).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'CANCELLED', failureClass: 'transient' });
  });

  it('passes the caller abort through to fetch', async () => {
    const controller = new AbortController();
    const send: QStashFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { reject(init.signal.reason); });
    });
    const { queue } = fixture(send);
    const pending = queue.enqueue(payload(), controller.signal).then(() => undefined, (e: unknown) => e);
    controller.abort();
    expect(await pending).toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects an invalid payload before any fetch', async () => {
    const send = replying(respond(201));
    await expect(fixture(send).queue.enqueue({ ...payload(), seq: 0 }, signal())).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('QStashQueue.probe', () => {
  it('is a constant UNKNOWN and makes no network call', async () => {
    const send = replying(respond(201));
    const { queue, lines } = fixture(send);
    const id = randomUUID();
    expect(await queue.probe(id, 1)).toEqual({ seq: 1, result: 'UNKNOWN' });
    expect(await queue.probe(id, 7)).toEqual({ seq: 7, result: 'UNKNOWN' });
    expect(send).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });
});

describe('QStashQueue secrets hygiene', () => {
  const scenarios: Array<[string, QStashFetch]> = [
    ['400 echoing the token', async () => respond(400, `{"error":"${TOKEN}"}`, { 'x-echo': TOKEN })],
    ['401 echoing the token', async () => respond(401, TOKEN, { 'www-authenticate': TOKEN })],
    ['403', async () => respond(403, TOKEN)],
    ['429', async () => respond(429, TOKEN, { 'retry-after': '10' })],
    ['500', async () => respond(500, TOKEN)],
    ['2xx without a messageId, token in the body', async () => respond(200, `{"note":"${TOKEN}"}`)],
    ['network error carrying request headers', async () => { throw Object.assign(new Error(`failed: Authorization: Bearer ${TOKEN}`), { cause: { headers: { authorization: `Bearer ${TOKEN}` } } }); }],
    ['abort reason carrying the token', async () => { throw new DOMException(TOKEN, 'AbortError'); }],
  ];
  it.each(scenarios)('%s: the token is in no error, stack, property or log line', async (_label, send) => {
    const { queue, lines } = fixture(send);
    const error = await queue.enqueue(payload(), signal()).then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(lines).toHaveLength(1);
    for (const surface of surfaces(error, lines)) expect(surface).not.toContain(TOKEN);
  });

  it('a successful publish logs nothing and returns no token', async () => {
    const { queue, lines } = fixture(replying(respond(201, `{"messageId":"msg_1","echo":"${TOKEN}"}`)));
    const result = await queue.publish(payload(), signal());
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(lines).toEqual([]);
  });

  it.each<[string, Partial<QStashQueueConfig>]>([
    ['http base URL', { baseUrl: 'http://qstash.upstash.io' }],
    ['base URL with a path', { baseUrl: 'https://qstash.upstash.io/v2' }],
    ['base URL with credentials', { baseUrl: `https://user:${TOKEN}@qstash.upstash.io` }],
    ['base URL with a trailing slash', { baseUrl: 'https://qstash.upstash.io/' }],
    ['worker URL with a path', { workerUrl: `${WORKER}/internal` }],
    ['worker URL that is not a URL', { workerUrl: `worker ${TOKEN}` }],
    ['ftp worker URL', { workerUrl: 'ftp://qp-worker.example.test' }],
    ['retries above 3', { retries: 4 }],
    ['negative retries', { retries: -1 }],
    ['fractional retries', { retries: 1.5 }],
    ['timeout without a unit', { timeout: '90' }],
    ['timeout below the floor', { timeout: '10s' }],
    ['timeout above the ceiling', { timeout: '16m' }],
    ['empty token', { token: '' }],
    ['token with whitespace', { token: `${TOKEN} extra` }],
    ['token with a newline', { token: `${TOKEN}\nX-Injected: 1` }],
    ['zero publish timeout', { publishTimeoutMs: 0 }],
  ])('constructor rejects %s with a value-free message', (_label, overrides) => {
    let thrown: unknown;
    try { fixture(replying(respond(201)), overrides); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Invalid QStash configuration');
    for (const surface of surfaces(thrown, [])) expect(surface).not.toContain(TOKEN);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 9, 21, 12, 0, 0);
  it.each<[string | null, number | undefined]>([
    [null, undefined], ['', undefined], ['0', undefined], ['-5', undefined], ['1.5', undefined], ['abc', undefined],
    ['30', 30], [' 5 ', 5], ['86400', 86_400], ['99999999', 86_400],
    ['Wed, 21 Oct 2026 12:00:45 GMT', 45], ['Wed, 21 Oct 2026 11:00:00 GMT', undefined], ['2026-10-21T12:00:45Z', undefined],
  ])('%j -> %j', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});

describe('LocalDispatchQueue qstash profile', () => {
  function fixture(qstash: { retries?: number; timeoutMs?: number; dedupWindowMs?: number } = {}) {
    let now = 1_000_000;
    const queue = new LocalDispatchQueue({ now: () => now }, { environment: 'test', profile: 'qstash', qstash });
    return { queue, advance: (ms: number) => { now += ms; } };
  }

  it('publish returns CREATED, then DEDUPLICATED for the same identity; one delivery only', async () => {
    const { queue } = fixture();
    const p = payload();
    expect(await queue.publish(p, signal())).toBe('CREATED');
    expect(await queue.publish(p, signal())).toBe('DEDUPLICATED');
    await expect(queue.enqueue(p, signal())).resolves.toBeUndefined();
    expect(queue.size()).toBe(1);
    const deliver = vi.fn(async () => 200);
    await queue.pump(deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a delivered identity stays deduplicated (no tombstone expiry like Cloud Tasks)', async () => {
    const { queue, advance } = fixture();
    const p = payload();
    await queue.publish(p, signal());
    await queue.pump(async () => 200);
    expect(queue.size()).toBe(0);
    advance(4_000_000); // past the 1 h Cloud Tasks tombstone
    expect(await queue.publish(p, signal())).toBe('DEDUPLICATED');
    expect(queue.size()).toBe(0);
  });

  it('a different seq is a different identity', async () => {
    const { queue } = fixture();
    const p = payload();
    expect(await queue.publish(p, signal())).toBe('CREATED');
    expect(await queue.publish({ ...p, seq: 2 }, signal())).toBe('CREATED');
    expect(queue.size()).toBe(2);
  });

  it('past the deduplication window the same identity is a new message (an extra delivery)', async () => {
    const { queue, advance } = fixture({ dedupWindowMs: 60_000 });
    const p = payload();
    await queue.publish(p, signal());
    advance(59_999);
    expect(await queue.publish(p, signal())).toBe('DEDUPLICATED');
    advance(1);
    expect(await queue.publish(p, signal())).toBe('CREATED');
    expect(queue.size()).toBe(2);
  });

  it('probe is a constant UNKNOWN, whether the message exists or not', async () => {
    const { queue } = fixture();
    const p = payload();
    expect(await queue.probe(p.requestId, 1)).toEqual({ seq: 1, result: 'UNKNOWN' });
    await queue.publish(p, signal());
    expect(await queue.probe(p.requestId, 1)).toEqual({ seq: 1, result: 'UNKNOWN' });
  });

  it('retries up to the configured count (retries + 1 deliveries), then drops the message', async () => {
    const { queue, advance } = fixture({ retries: 2 });
    await queue.publish(payload(), signal());
    const deliver = vi.fn(async () => 503);
    await queue.pump(deliver);
    advance(12_000); await queue.pump(deliver); // default backoff is about 12.2 s
    expect(deliver).toHaveBeenCalledTimes(1);
    advance(300); await queue.pump(deliver);
    expect(deliver).toHaveBeenCalledTimes(2);
    advance(154_000); await queue.pump(deliver); // about 148 s
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(queue.size()).toBe(0);
    advance(86_400_000); await queue.pump(deliver);
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('retries: 0 means a single delivery', async () => {
    const { queue } = fixture({ retries: 0 });
    await queue.publish(payload(), signal());
    const deliver = vi.fn(async () => 500);
    await queue.pump(deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
  });

  it('honours Retry-After over the default backoff, in both directions', async () => {
    const { queue, advance } = fixture({ retries: 3 });
    await queue.publish(payload(), signal());
    const deliver = vi.fn<() => Promise<{ status: number; retryAfterSeconds?: number }>>();
    deliver.mockResolvedValueOnce({ status: 503, retryAfterSeconds: 30 }).mockResolvedValueOnce({ status: 409, retryAfterSeconds: 5 });
    await queue.pump(deliver);
    advance(29_999); await queue.pump(deliver);
    expect(deliver).toHaveBeenCalledTimes(1); // the default 12 s backoff would already have fired
    advance(1); await queue.pump(deliver);
    expect(deliver).toHaveBeenCalledTimes(2);
    advance(4_999); await queue.pump(deliver); // 5 s, shorter than the default 148 s
    expect(deliver).toHaveBeenCalledTimes(2);
    deliver.mockResolvedValueOnce({ status: 200 });
    advance(1); await queue.pump(deliver);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(queue.size()).toBe(0);
  });

  it('ignores Retry-After on a 2xx and a zero Retry-After', async () => {
    const { queue, advance } = fixture();
    await queue.publish(payload(), signal());
    await queue.pump(async () => ({ status: 503, retryAfterSeconds: 0 }));
    advance(12_300);
    expect(await queue.pump(async () => ({ status: 200, retryAfterSeconds: 60 }))).toBe(1);
    expect(queue.size()).toBe(0);
  });

  it('the delivery timeout stops the wait, but the handler keeps running and may finish late', async () => {
    const { queue, advance } = fixture({ timeoutMs: 10_000 });
    await queue.publish(payload(), signal());
    let release!: () => void;
    let handlerFinished = false;
    const hung = queue.pump(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      handlerFinished = true;
      return 200;
    });
    await Promise.resolve(); await Promise.resolve();
    advance(10_000);
    expect(await queue.pump(async () => 200)).toBe(0); // the wait is over; the retry is not due yet
    await hung;
    expect(queue.size()).toBe(1); // counted as a failed delivery, not acknowledged
    expect(handlerFinished).toBe(false);
    release(); await Promise.resolve(); await Promise.resolve();
    expect(handlerFinished).toBe(true); // the handler finished after the timeout
    expect(queue.size()).toBe(1); // its late 200 does not acknowledge the message
    advance(12_300);
    const redelivered = vi.fn(async () => 200);
    await queue.pump(redelivered);
    expect(redelivered).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);
  });

  it('a timed-out delivery uses up one of the retries', async () => {
    const { queue, advance } = fixture({ timeoutMs: 10_000, retries: 0 });
    await queue.publish(payload(), signal());
    await queue.pump(async () => { advance(10_000); return 200; });
    expect(queue.size()).toBe(0);
  });

  it('takes its default delivery timeout from the profile, not the 30 s Cloud Tasks deadline', async () => {
    expect(fixture().queue.deadlineMs).toBe(90_000);
    expect(fixture({ timeoutMs: 61_000 }).queue.deadlineMs).toBe(61_000);
    expect(new LocalDispatchQueue({ now: () => 0 }, { environment: 'test' }).deadlineMs).toBe(30_000);
  });

  it('delivers QStash-style headers, not Cloud Tasks ones', async () => {
    const { queue, advance } = fixture();
    await queue.publish(payload(), signal());
    const seen: Array<Record<string, string>> = [];
    const deliver = async (_p: unknown, headers: Record<string, string>) => { seen.push(headers); return 503; };
    await queue.pump(deliver); advance(13_000); await queue.pump(deliver);
    expect(seen.map((headers) => headers['upstash-retried'])).toEqual(['0', '1']);
    expect(seen.every((headers) => !Object.keys(headers).some((name) => name.startsWith('x-cloudtasks')))).toBe(true);
  });

  it('keeps the fault switches and the production ban', async () => {
    const q = new LocalDispatchQueue({ now: () => 0 }, { environment: 'test', profile: 'qstash', faults: { create: 'fail' } });
    await expect(q.publish(payload(), signal())).rejects.toThrow('LOCAL_CREATE_FAILED');
    expect(() => new LocalDispatchQueue({ now: () => 0 }, { environment: 'production', profile: 'qstash' })).toThrow();
  });

  it.each([{ retries: 4 }, { retries: -1 }, { retries: 1.5 }, { timeoutMs: 0 }, { dedupWindowMs: 0 }])('rejects invalid profile options %j', (qstash) => {
    expect(() => new LocalDispatchQueue({ now: () => 0 }, { environment: 'test', profile: 'qstash', qstash })).toThrow(/Invalid local queue limits/);
  });

  it('the default profile is unchanged: duplicates are a no-op, probe sees the task', async () => {
    const queue = new LocalDispatchQueue({ now: () => 0 }, { environment: 'test' });
    const p = payload();
    expect(queue.profile).toBe('cloud-tasks');
    expect(await queue.publish(p, signal())).toBe('CREATED');
    expect(await queue.publish(p, signal())).toBe('DEDUPLICATED');
    expect(await queue.probe(p.requestId, 1)).toEqual({ seq: 1, result: 'EXISTS' });
  });
});
