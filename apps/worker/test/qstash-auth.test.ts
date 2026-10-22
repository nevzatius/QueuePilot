import { createHash, createHmac } from 'node:crypto';
import util from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  createCallerVerifier, createLogger, loadConfig, OidcCallerVerifier, QSTASH_CLOCK_TOLERANCE_SECONDS, QSTASH_MAX_TOKEN_CHARS,
  QStashCallerVerifier, QStashQueue,
} from '@queuepilot/core';
import type { RejectReason } from '@queuepilot/core';
import { LEASE_MS, RETRY_WATCHDOG_MS } from '@queuepilot/domain';
import { buildWorkerApp, RETRY_AFTER_SECONDS } from '../src/app.js';

// Recognisable fakes, generated for this file only; none of them is a real key or token.
const KEY = { current: 'FAKE-current-key-4c2d80', next: 'FAKE-next-key-9be615' };
const WORKER = 'https://qp-worker.example.test';
const TASKS_URL = `${WORKER}/internal/tasks`;
const RECONCILE_URL = `${WORKER}/internal/reconcile`;
const NOW_MS = Date.UTC(2026, 9, 21, 12, 0, 0);
const NOW = NOW_MS / 1000;
const clock = { now: () => NOW_MS };
const PROD_QSTASH: Record<string, string> = { QP_ENV: 'production', GCLOUD_PROJECT: 'qp-test-project', QP_WORKER_URL: WORKER,
  REDIS_URL: 'rediss://default:FAKE-redis-pass-1d84e7@redis.invalid:6380', QP_QUEUE_ADAPTER: 'qstash',
  QSTASH_TOKEN: 'FAKE-qstash-token-7f3a91', QSTASH_CURRENT_SIGNING_KEY: KEY.current, QSTASH_NEXT_SIGNING_KEY: KEY.next };

const bodyHash = (body: string | Uint8Array) => createHash('sha256').update(body).digest('base64url');
const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
type Claims = Record<string, unknown>;
/** A token as QStash builds it (HS256, claims iss/sub/exp/nbf/iat/jti/body), generated here with a fake key. */
function sign(body: string | Uint8Array, over: { claims?: Claims; key?: string; header?: unknown; hmac?: 'sha256' | 'sha384' | 'sha512'; sub?: string; rawPayload?: string } = {}) {
  const claims: Claims = { iss: 'Upstash', sub: over.sub ?? TASKS_URL, exp: NOW + 300, nbf: NOW - 5, iat: NOW - 5,
    jti: 'jwt_FAKE', body: bodyHash(body), ...over.claims };
  for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
  const signingInput = `${b64(over.header ?? { alg: 'HS256', typ: 'JWT' })}.${b64(over.rawPayload ?? claims)}`;
  return `${signingInput}.${createHmac(over.hmac ?? 'sha256', over.key ?? KEY.current).update(signingInput).digest('base64url')}`;
}
const verifier = (workerUrl = WORKER) => new QStashCallerVerifier({ QP_WORKER_URL: workerUrl,
  QSTASH_CURRENT_SIGNING_KEY: KEY.current, QSTASH_NEXT_SIGNING_KEY: KEY.next }, clock);
const check = (signature: string | undefined, body: string | Uint8Array = '{"a":1}', caller: 'tasks' | 'scheduler' = 'tasks') =>
  verifier().check({ signature, rawBody: Buffer.from(body) }, caller);
const BODY = '{"a":1}';

describe('QStash signature verifier: accepted', () => {
  it.each([
    ['current key', { key: KEY.current }],
    ['next key (rotation)', { key: KEY.next }],
  ])('accepts a token signed with the %s', (_label, over) => {
    expect(check(sign(BODY, over))).toEqual({ ok: true });
  });
  it('accepts the scheduler tick for its own route, with an empty body hashed as the empty string', () => {
    const token = sign('', { sub: RECONCILE_URL });
    expect(token).toContain(b64({ alg: 'HS256', typ: 'JWT' }));
    expect(check(token, '', 'scheduler')).toEqual({ ok: true });
    expect(bodyHash('')).toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });
  it('accepts a padded body claim (QStash SDK strips "=" before comparing) and a token without nbf', () => {
    expect(check(sign(BODY, { claims: { body: `${bodyHash(BODY)}=` } }))).toEqual({ ok: true });
    expect(check(sign(BODY, { claims: { nbf: undefined } }))).toEqual({ ok: true });
  });
  it('hashes the exact bytes, not a re-serialisation: odd whitespace and non-UTF-8 bytes verify as sent', () => {
    const spaced = '{ "a" :  1 }\n';
    expect(check(sign(spaced), spaced)).toEqual({ ok: true });
    const binary = Uint8Array.from([0xff, 0xfe, 0x00, 0x7b]);
    expect(check(sign(binary), binary as unknown as string)).toEqual({ ok: true });
  });
  it('tolerance: exp and nbf are accepted just inside the clock tolerance', () => {
    expect(check(sign(BODY, { claims: { exp: NOW - QSTASH_CLOCK_TOLERANCE_SECONDS + 1 } }))).toEqual({ ok: true });
    expect(check(sign(BODY, { claims: { nbf: NOW + QSTASH_CLOCK_TOLERANCE_SECONDS - 1 } }))).toEqual({ ok: true });
  });
});

describe('QStash signature verifier: rejected', () => {
  const good = () => sign(BODY);
  const [header, payload, signature] = good().split('.') as [string, string, string];
  const rows: Array<[string, string | undefined, RejectReason]> = [
    ['missing header', undefined, 'MISSING_HEADER'],
    ['empty header', '', 'MISSING_HEADER'],
    ['not a JWT', 'not-a-token', 'BAD_FORMAT'],
    ['two segments', `${header}.${payload}`, 'BAD_FORMAT'],
    ['four segments', `${good()}.extra`, 'BAD_FORMAT'],
    ['empty signature segment', `${header}.${payload}.`, 'BAD_FORMAT'],
    ['non base64url characters', `${header}.${payload}.sig+nature/==`, 'BAD_FORMAT'],
    ['whitespace in the token', `${header}.${payload} .${signature}`, 'BAD_FORMAT'],
    ['oversize token', `${header}.${b64({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), pad: 'x'.repeat(QSTASH_MAX_TOKEN_CHARS) })}.${signature}`, 'BAD_FORMAT'],
    ['header is not JSON', sign(BODY, { header: 'not json' }), 'BAD_FORMAT'],
    ['header is an array', sign(BODY, { header: ['HS256'] }), 'BAD_FORMAT'],
    ['alg none', `${b64({ alg: 'none', typ: 'JWT' })}.${payload}.`, 'BAD_FORMAT'],
    ['alg none with a signature segment', `${b64({ alg: 'none' })}.${payload}.${signature}`, 'BAD_FORMAT'],
    ['header with crit', sign(BODY, { header: { alg: 'HS256', typ: 'JWT', crit: ['exp'], exp: 1 } }), 'BAD_FORMAT'],
    ['header with an empty crit', sign(BODY, { header: { alg: 'HS256', crit: [] } }), 'BAD_FORMAT'],
    ['alg missing', sign(BODY, { header: { typ: 'JWT' } }), 'BAD_FORMAT'],
    ['alg lowercase hs256', sign(BODY, { header: { alg: 'hs256' } }), 'BAD_FORMAT'],
    ['alg HS384, validly signed', sign(BODY, { header: { alg: 'HS384' }, hmac: 'sha384' }), 'BAD_FORMAT'],
    ['alg HS512, validly signed', sign(BODY, { header: { alg: 'HS512' }, hmac: 'sha512' }), 'BAD_FORMAT'],
    ['alg RS256', sign(BODY, { header: { alg: 'RS256' } }), 'BAD_FORMAT'],
    ['signed with an unknown key', sign(BODY, { key: 'FAKE-foreign-key' }), 'BAD_SIGNATURE'],
    ['truncated signature', `${header}.${payload}.${signature.slice(0, 20)}`, 'BAD_SIGNATURE'],
    ['signature of the right length but wrong', `${header}.${payload}.${'A'.repeat(signature.length)}`, 'BAD_SIGNATURE'],
    ['payload changed after signing (sub)', `${header}.${b64({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: `${WORKER}/internal/evil` })}.${signature}`, 'BAD_SIGNATURE'],
    ['issuer is not Upstash', sign(BODY, { claims: { iss: 'Someone' } }), 'BAD_CLAIM'],
    ['issuer missing', sign(BODY, { claims: { iss: undefined } }), 'BAD_CLAIM'],
    ['sub is another host', sign(BODY, { sub: 'https://other.example.test/internal/tasks' }), 'BAD_CLAIM'],
    ['sub is the other route', sign(BODY, { sub: RECONCILE_URL }), 'BAD_CLAIM'],
    ['sub has a trailing slash', sign(BODY, { sub: `${TASKS_URL}/` }), 'BAD_CLAIM'],
    ['sub has a query', sign(BODY, { sub: `${TASKS_URL}?x=1` }), 'BAD_CLAIM'],
    ['sub is http instead of https', sign(BODY, { sub: 'http://qp-worker.example.test/internal/tasks' }), 'BAD_CLAIM'],
    ['sub missing', sign(BODY, { claims: { sub: undefined } }), 'BAD_CLAIM'],
    ['exp missing', sign(BODY, { claims: { exp: undefined } }), 'BAD_CLAIM'],
    ['exp is a string', sign(BODY, { claims: { exp: String(NOW + 300) } }), 'BAD_CLAIM'],
    ['nbf is a string', sign(BODY, { claims: { nbf: String(NOW - 5) } }), 'BAD_CLAIM'],
    ['body claim missing', sign(BODY, { claims: { body: undefined } }), 'BAD_CLAIM'],
    ['exp 1e999 (JSON Infinity)', sign(BODY, { rawPayload: `{"iss":"Upstash","sub":"${TASKS_URL}","exp":1e999,"body":"${bodyHash(BODY)}"}` }), 'BAD_CLAIM'],
    ['exp -1e999', sign(BODY, { rawPayload: `{"iss":"Upstash","sub":"${TASKS_URL}","exp":-1e999,"body":"${bodyHash(BODY)}"}` }), 'BAD_CLAIM'],
    ['exp null (what JSON.stringify makes of Infinity)', sign(BODY, { claims: { exp: Number.POSITIVE_INFINITY } }), 'BAD_CLAIM'],
    ['nbf 1e999', sign(BODY, { rawPayload: `{"iss":"Upstash","sub":"${TASKS_URL}","exp":${NOW + 300},"nbf":1e999,"body":"${bodyHash(BODY)}"}` }), 'BAD_CLAIM'],
    ['nbf -1e999', sign(BODY, { rawPayload: `{"iss":"Upstash","sub":"${TASKS_URL}","exp":${NOW + 300},"nbf":-1e999,"body":"${bodyHash(BODY)}"}` }), 'BAD_CLAIM'],
    ['sub differs in path case', sign(BODY, { sub: `${WORKER}/internal/Tasks` }), 'BAD_CLAIM'],
    ['sub differs in whole-path case', sign(BODY, { sub: `${WORKER}/INTERNAL/TASKS` }), 'BAD_CLAIM'],
    ['sub differs in host case', sign(BODY, { sub: 'https://QP-Worker.example.test/internal/tasks' }), 'BAD_CLAIM'],
    ['sub is percent-encoded (not decoded)', sign(BODY, { sub: `${WORKER}/internal/%74asks` }), 'BAD_CLAIM'],
    ['sub is percent-encoded in the slash', sign(BODY, { sub: `${WORKER}%2Finternal%2Ftasks` }), 'BAD_CLAIM'],
    ['expired', sign(BODY, { claims: { exp: NOW - QSTASH_CLOCK_TOLERANCE_SECONDS - 1 } }), 'EXPIRED'],
    ['expired long ago', sign(BODY, { claims: { exp: NOW - 86_400 } }), 'EXPIRED'],
    ['nbf in the future', sign(BODY, { claims: { nbf: NOW + QSTASH_CLOCK_TOLERANCE_SECONDS + 1 } }), 'EXPIRED'],
    ['body claim of another body', sign('{"a":2}'), 'BODY_MISMATCH'],
    ['empty body claim', sign(BODY, { claims: { body: '' } }), 'BODY_MISMATCH'],
  ];
  it.each(rows)('%s', (_label, token, reason) => {
    expect(check(token)).toEqual({ ok: false, reason });
  });
  it('a body changed by one byte after signing is rejected', () => {
    const token = sign(BODY);
    expect(check(token, '{"a":2}')).toEqual({ ok: false, reason: 'BODY_MISMATCH' });
    expect(check(token, `${BODY} `)).toEqual({ ok: false, reason: 'BODY_MISMATCH' });
    expect(check(token, '')).toEqual({ ok: false, reason: 'BODY_MISMATCH' });
  });
  it('a tasks token does not authenticate the scheduler route and vice versa', () => {
    expect(check(sign(BODY), BODY, 'scheduler')).toEqual({ ok: false, reason: 'BAD_CLAIM' });
    expect(check(sign(BODY, { sub: RECONCILE_URL }), BODY, 'tasks')).toEqual({ ok: false, reason: 'BAD_CLAIM' });
  });
  it('the expected sub comes from the configured worker URL: a token for another configured origin fails', () => {
    expect(verifier('https://other-worker.example.test').check({ signature: sign(BODY), rawBody: Buffer.from(BODY) }, 'tasks'))
      .toEqual({ ok: false, reason: 'BAD_CLAIM' });
  });
  it('uses the production clock when none is injected: an expired token without nbf is rejected, a fresh one accepted', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW_MS);
      const real = new QStashCallerVerifier({ QP_WORKER_URL: WORKER, QSTASH_CURRENT_SIGNING_KEY: KEY.current, QSTASH_NEXT_SIGNING_KEY: KEY.next });
      const run = (claims: Claims) => real.check({ signature: sign(BODY, { claims: { nbf: undefined, ...claims } }), rawBody: Buffer.from(BODY) }, 'tasks');
      expect(run({ exp: NOW - QSTASH_CLOCK_TOLERANCE_SECONDS - 1 })).toEqual({ ok: false, reason: 'EXPIRED' });
      expect(run({ exp: NOW + 60 })).toEqual({ ok: true });
      vi.setSystemTime(NOW_MS + 3_600_000);
      expect(run({ exp: NOW + 60 })).toEqual({ ok: false, reason: 'EXPIRED' });
    } finally { vi.useRealTimers(); }
  });
  it('the legacy bearer path never accepts', async () => {
    expect(await verifier().verify()).toBe(false);
  });
  it('construction fails with constant messages and no value', () => {
    const base = { QP_WORKER_URL: WORKER, QSTASH_CURRENT_SIGNING_KEY: KEY.current, QSTASH_NEXT_SIGNING_KEY: KEY.next };
    for (const bad of [{ QSTASH_CURRENT_SIGNING_KEY: undefined }, { QSTASH_NEXT_SIGNING_KEY: '  ' },
      { QSTASH_CURRENT_SIGNING_KEY: `${KEY.current}
` }, { QSTASH_NEXT_SIGNING_KEY: ` ${KEY.next}` }]) {
      expect(() => new QStashCallerVerifier({ ...base, ...bad })).toThrow(/^QStash signing keys required$/);
    }
    expect(() => new QStashCallerVerifier({ ...base, QP_WORKER_URL: `${WORKER}/path` })).toThrow(/^Worker URL must be an origin$/);
  });
  it('the sub matches the destination the B9-2 adapter publishes to, for the tasks route', async () => {
    const urls: string[] = [];
    const queue = new QStashQueue({ token: 'FAKE-qstash-token-7f3a91', baseUrl: 'https://qstash.upstash.io', workerUrl: WORKER, retries: 2, timeout: '90s' },
      createLogger({ write: () => {} }), clock, async (url) => { urls.push(url); return { status: 201, headers: { get: () => null }, text: async () => '{"messageId":"m"}' }; });
    await queue.enqueue({ requestId: crypto.randomUUID(), tenantId: 'test-queue', seq: 1, correlationId: crypto.randomUUID() }, new AbortController().signal);
    expect(urls[0]!.endsWith(`/v2/publish/${TASKS_URL}`)).toBe(true);
  });
});

describe('createCallerVerifier branching', () => {
  it('loadConfig(production qstash) then createCallerVerifier raises no OIDC error (B9-1 review F3)', () => {
    const config = loadConfig(PROD_QSTASH);
    expect(config.QP_WORKER_AUTH_MODE).toBe('qstash');
    expect(config.QP_TASKS_OIDC_AUDIENCE).toBeUndefined();
    expect(config.QP_TASKS_INVOKER_SA).toBeUndefined();
    const created = createCallerVerifier(config, clock);
    expect(created).toBeInstanceOf(QStashCallerVerifier);
    expect(created).not.toBeInstanceOf(OidcCallerVerifier);
  });
  it('a hand-built config with qstash auth on another backend still fails closed, without a value', () => {
    expect(() => createCallerVerifier({ ...loadConfig(PROD_QSTASH), QP_QUEUE_ADAPTER: 'cloud' })).toThrow(/^Worker auth mode does not match the queue backend$/);
  });
  it('the OIDC and local branches are unchanged', () => {
    expect(() => createCallerVerifier({ ...loadConfig(PROD_QSTASH), QP_WORKER_AUTH_MODE: 'oidc' })).toThrow(/OIDC audience/);
    expect(() => createCallerVerifier({ ...loadConfig(PROD_QSTASH), QP_WORKER_AUTH_MODE: 'local' })).toThrow(/Unsafe local/);
  });
});

// Route level: the real app, the real verifier, stub services that count calls.
const payload = () => ({ requestId: crypto.randomUUID(), tenantId: 'test-queue', seq: 1, correlationId: crypto.randomUUID() });
function harness(deliver: () => Promise<{ http: number; kind: string }> = async () => ({ http: 200, kind: 'COMPLETED' })) {
  const lines: string[] = [];
  const worker = { deliver: vi.fn(deliver) };
  const reconciler = { run: vi.fn(async () => ({ scanned: 0 })) };
  const app = buildWorkerApp({ verifier: createCallerVerifier(loadConfig(PROD_QSTASH), clock), store: { health: async () => {} } as never,
    worker: worker as never, reconciler: reconciler as never, logStream: { write: (line) => { lines.push(line); } } });
  return { app, lines, worker, reconciler };
}
const post = (app: ReturnType<typeof harness>['app'], url: string, body: string | undefined, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, ...(body !== undefined && { payload: body }) });

describe('worker routes under QStash auth', () => {
  it('accepts a signed task and a signed tick (empty body, no content type)', async () => {
    const { app, worker, reconciler } = harness();
    const body = JSON.stringify(payload());
    const task = await post(app, '/internal/tasks', body, { 'upstash-signature': sign(body) });
    expect(task.statusCode).toBe(200);
    expect(worker.deliver).toHaveBeenCalledTimes(1);
    const tick = await app.inject({ method: 'POST', url: '/internal/reconcile', headers: { 'upstash-signature': sign('', { sub: RECONCILE_URL }) } });
    expect(tick.statusCode).toBe(200);
    expect(reconciler.run).toHaveBeenCalledTimes(1);
    await app.close();
  });
  it('a tick with a non-JSON body and content type is verified on its bytes', async () => {
    const { app, reconciler } = harness();
    const response = await app.inject({ method: 'POST', url: '/internal/reconcile', payload: 'tick=1',
      headers: { 'content-type': 'text/plain', 'upstash-signature': sign('tick=1', { sub: RECONCILE_URL }) } });
    expect(response.statusCode).toBe(200);
    expect(reconciler.run).toHaveBeenCalledTimes(1);
    await app.close();
  });
  const unauthenticated: Array<[string, (app: ReturnType<typeof harness>['app'], body: string) => ReturnType<typeof post>]> = [
    ['no signature header', (app, body) => post(app, '/internal/tasks', body)],
    ['an OIDC-style bearer only', (app, body) => post(app, '/internal/tasks', body, { authorization: 'Bearer abc.def.ghi' })],
    ['a garbage signature', (app, body) => post(app, '/internal/tasks', body, { 'upstash-signature': 'garbage' })],
    ['a foreign key', (app, body) => post(app, '/internal/tasks', body, { 'upstash-signature': sign(body, { key: 'FAKE-foreign-key' }) })],
    ['a body changed after signing', (app, body) => post(app, '/internal/tasks', body.replace('"seq":1', '"seq":9'), { 'upstash-signature': sign(body) })],
    ['the scheduler token on the tasks route', (app, body) => post(app, '/internal/tasks', body, { 'upstash-signature': sign(body, { sub: RECONCILE_URL }) })],
    ['an expired token', (app, body) => post(app, '/internal/tasks', body, { 'upstash-signature': sign(body, { claims: { exp: NOW - 600 } }) })],
    ['unsigned malformed JSON (no 400 before the 401)', (app) => post(app, '/internal/tasks', '{not json')],
    ['unsigned text/plain (no 415 before the 401)', (app, body) => app.inject({ method: 'POST', url: '/internal/tasks', payload: body, headers: { 'content-type': 'text/plain' } })],
    ['the tasks token on the reconcile route', (app, body) => post(app, '/internal/reconcile', body, { 'upstash-signature': sign(body) })],
    ['no signature on the reconcile route', (app) => post(app, '/internal/reconcile', undefined)],
  ];
  it.each(unauthenticated)('answers 401 with a constant body and never reaches the handler: %s', async (_label, send) => {
    const { app, worker, reconciler, lines } = harness();
    const response = await send(app, JSON.stringify(payload()));
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(response.headers['retry-after']).toBeUndefined();
    expect(worker.deliver).not.toHaveBeenCalled();
    expect(reconciler.run).not.toHaveBeenCalled();
    expect(lines.join('')).toContain('CALLER_REJECTED');
    await app.close();
  });
  it('a signed but invalid payload is 400, only after authentication', async () => {
    const { app, worker } = harness();
    for (const body of ['{not json', '{"requestId":"x"}']) {
      const response = await post(app, '/internal/tasks', body, { 'upstash-signature': sign(body) });
      expect(response.statusCode).toBe(400);
    }
    expect(worker.deliver).not.toHaveBeenCalled();
    await app.close();
  });
  it('health and readiness stay open', async () => {
    const { app } = harness();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
    await app.close();
  });
  it('/ready calls the store (one Firestore read with the service-account credential) and answers 503 without detail when it fails; /health never calls it', async () => {
    const health = vi.fn(async () => { throw new Error('FAKE-credential-detail 16 UNAUTHENTICATED'); });
    const app = buildWorkerApp({ verifier: createCallerVerifier(loadConfig(PROD_QSTASH), clock), store: { health } as never,
      worker: { deliver: vi.fn() } as never, reconciler: { run: vi.fn() } as never, logStream: { write: () => {} } });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect(health).not.toHaveBeenCalled();
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(health).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('FAKE-credential-detail');
    await app.close();
  });
  it('Host and X-Forwarded-* headers cannot change the expected sub', async () => {
    const { app, worker } = harness();
    const body = JSON.stringify(payload());
    const response = await post(app, '/internal/tasks', body, { host: 'evil.example.test', 'x-forwarded-host': 'evil.example.test',
      'x-forwarded-proto': 'http', 'upstash-signature': sign(body, { sub: 'http://evil.example.test/internal/tasks' }) });
    expect(response.statusCode).toBe(401);
    expect(worker.deliver).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('Retry-After on 409 and 503', () => {
  const signed = (app: ReturnType<typeof harness>['app']) => {
    const body = JSON.stringify(payload());
    return post(app, '/internal/tasks', body, { 'upstash-signature': sign(body) });
  };
  it('names its values after the lease and retry watchdog constants', () => {
    expect(RETRY_AFTER_SECONDS).toEqual({ 409: LEASE_MS / 1000, 503: RETRY_WATCHDOG_MS / 1000 });
  });
  it.each([[409, 'LEASE_HELD'], [409, 'FENCED'], [503, 'RETRY']])('a %i answer (%s) carries Retry-After', async (http, kind) => {
    const { app } = harness(async () => ({ http, kind }));
    const response = await signed(app);
    expect(response.statusCode).toBe(http);
    expect(response.json()).toEqual({ code: kind });
    expect(response.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS[http as 409 | 503]));
    await app.close();
  });
  it.each([200, 400])('a %i answer has none', async (http) => {
    const { app } = harness(async () => ({ http, kind: 'X' }));
    expect((await signed(app)).headers['retry-after']).toBeUndefined();
    await app.close();
  });
  it('a store failure (503 UNAVAILABLE) carries it on both internal routes, not on /ready', async () => {
    const { app, reconciler, lines } = harness(async () => { throw new Error('firestore down'); });
    const task = await signed(app);
    expect(task.statusCode).toBe(503);
    expect(task.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS[503]));
    reconciler.run.mockRejectedValueOnce(new Error('firestore down'));
    const tick = await app.inject({ method: 'POST', url: '/internal/reconcile', headers: { 'upstash-signature': sign('', { sub: RECONCILE_URL }) } });
    expect(tick.statusCode).toBe(503);
    expect(tick.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS[503]));
    expect(lines.join('')).not.toContain('firestore down');
    await app.close();
  });
  it('the OIDC path gets the same header and keeps its 403', async () => {
    const worker = { deliver: vi.fn(async () => ({ http: 409, kind: 'LEASE_HELD' })) };
    const app = buildWorkerApp({ verifier: { verify: async (authorization) => authorization === 'Bearer ok' }, store: { health: async () => {} } as never,
      worker: worker as never, reconciler: { run: vi.fn() } as never, logger: false });
    const denied = await post(app, '/internal/tasks', JSON.stringify(payload()));
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['retry-after']).toBeUndefined();
    expect(worker.deliver).not.toHaveBeenCalled();
    const lease = await post(app, '/internal/tasks', JSON.stringify(payload()), { authorization: 'Bearer ok' });
    expect(lease.statusCode).toBe(409);
    expect(lease.headers['retry-after']).toBe(String(RETRY_AFTER_SECONDS[409]));
    await app.close();
  });
});

describe('secrets never leave the verifier', () => {
  const FAKE_TOKEN_MARK = 'FAKE-TOKEN-SEGMENT-5e1c77';
  const SECRETS = [KEY.current, KEY.next, PROD_QSTASH.QSTASH_TOKEN!, 'FAKE-redis-pass-1d84e7', FAKE_TOKEN_MARK];
  const everywhere = (value: unknown) => `${util.inspect(value, { depth: 6, showHidden: true })}${JSON.stringify(value) ?? ''}`;

  it('rejected requests of every kind leave no key, token or claim in the logs or responses', async () => {
    const { app, lines } = harness();
    const body = JSON.stringify(payload());
    const forged = sign(body, { key: 'FAKE-foreign-key', claims: { sub: `${WORKER}/internal/${FAKE_TOKEN_MARK}`, jti: FAKE_TOKEN_MARK } });
    const answers = [
      await post(app, '/internal/tasks', body, { 'upstash-signature': forged }),
      await post(app, '/internal/tasks', body, { 'upstash-signature': `${FAKE_TOKEN_MARK}.${FAKE_TOKEN_MARK}.${FAKE_TOKEN_MARK}` }),
      await post(app, '/internal/tasks', body, { 'upstash-signature': FAKE_TOKEN_MARK }),
      await post(app, '/internal/tasks', body, { 'upstash-signature': sign(body, { claims: { jti: FAKE_TOKEN_MARK, exp: NOW - 999 } }) }),
      await post(app, '/internal/tasks', body, { authorization: `Bearer ${FAKE_TOKEN_MARK}` }),
    ];
    for (const response of answers) expect(response.statusCode).toBe(401);
    const output = lines.join('') + answers.map((response) => response.body + JSON.stringify(response.headers)).join('');
    for (const secret of SECRETS) expect(output).not.toContain(secret);
    expect(output).not.toContain(Buffer.from(FAKE_TOKEN_MARK).toString('base64url'));
    // Value-free reason codes are what is logged.
    expect(output).toMatch(/"reason":"(BAD_SIGNATURE|BAD_FORMAT|MISSING_HEADER|EXPIRED)"/);
    await app.close();
  });
  it('config validation errors for the auth matrix, the verifier object and its errors do not carry the keys', () => {
    const errors: string[] = [];
    for (const env of [{ ...PROD_QSTASH, QP_WORKER_AUTH_MODE: 'oidc' }, { ...PROD_QSTASH, QP_WORKER_AUTH_MODE: 'bogus' },
      { ...PROD_QSTASH, QP_QUEUE_ADAPTER: 'cloud', QP_WORKER_AUTH_MODE: 'qstash' }]) {
      try { loadConfig(env); } catch (error) { errors.push(everywhere(error) + String(error)); }
    }
    expect(errors).toHaveLength(3);
    try { new QStashCallerVerifier({ QP_WORKER_URL: `${WORKER}/${KEY.current}`, QSTASH_CURRENT_SIGNING_KEY: KEY.current, QSTASH_NEXT_SIGNING_KEY: KEY.next }); }
    catch (error) { errors.push(everywhere(error)); }
    const output = errors.join('') + everywhere(verifier()) + String(verifier()) + JSON.stringify(verifier());
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });
});

describe('delivery mode: route allow-list and unsigned requests (PR #5 review F7, F1)', () => {
  const OPEN = ['GET /health', 'GET /ready'];
  const SIGNED = ['POST /internal/tasks', 'POST /internal/reconcile'];
  /** Every registered "METHOD /path" pair, from the router's own listing. */
  function registered(app: ReturnType<typeof harness>['app']): string[] {
    const found: string[] = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /(\/\S*) \(([A-Z, ]+)\)/.exec(line);
      if (match) for (const method of match[2]!.split(', ')) found.push(`${method} ${match[1]}`);
    }
    return found;
  }
  it('every registered route is on the allow-list or refuses an unsigned call, so a new route cannot be open by accident', async () => {
    const { app, worker, reconciler, lines } = harness();
    app.get('/internal/forgotten', async () => ({ leaked: true }));
    app.post('/admin/new', async () => ({ leaked: true }));
    await app.ready();
    const routes = registered(app);
    expect(routes).toEqual(expect.arrayContaining([...OPEN, ...SIGNED, 'GET /internal/forgotten', 'POST /admin/new']));
    for (const route of routes) {
      const [method, url] = route.split(' ') as [string, string];
      if (method === 'HEAD' || OPEN.includes(route)) continue;
      const response = await app.inject({ method: method as 'GET' | 'POST', url, headers: { 'content-type': 'application/json' }, ...(method === 'POST' && { payload: '{}' }) });
      expect(response.statusCode, route).toBe(SIGNED.includes(route) ? 401 : 403);
      expect(response.body, route).not.toContain('leaked');
    }
    expect(routes.filter((route) => !OPEN.includes(route) && !SIGNED.includes(route) && !route.startsWith('HEAD ')).sort())
      .toEqual(['GET /internal/forgotten', 'POST /admin/new']);
    expect(worker.deliver).not.toHaveBeenCalled();
    expect(reconciler.run).not.toHaveBeenCalled();
    expect(lines.join('')).toContain('CALLER_REJECTED');
    await app.close();
  });
  it('an unmatched path is refused too', async () => {
    const { app } = harness();
    expect((await app.inject({ method: 'GET', url: '/nothing' })).statusCode).toBe(403);
    await app.close();
  });

  const framing: Array<[string, string, (app: ReturnType<typeof harness>['app'], url: string) => ReturnType<typeof post>]> = [
    ['an invalid Content-Type (;;;bad)', '/internal/tasks', (app, url) => post(app, url, '{"a":1}', { 'content-type': ';;;bad' })],
    ['an invalid Content-Type on the reconcile route', '/internal/reconcile', (app, url) => post(app, url, '{"a":1}', { 'content-type': ';;;bad' })],
    ['a body above the 4096-byte limit', '/internal/tasks', (app, url) => post(app, url, 'x'.repeat(4097))],
    ['a body far above the limit on the reconcile route', '/internal/reconcile', (app, url) => post(app, url, 'x'.repeat(100_000), { 'content-type': 'text/plain' })],
    ['a Content-Length that does not match the body', '/internal/tasks', (app, url) => post(app, url, '{"a":1,"b":2}', { 'content-length': '3' })],
    ['a Content-Length larger than the body', '/internal/reconcile', (app, url) => post(app, url, '{"a":1}', { 'content-length': '500' })],
  ];
  it.each(framing)('unsigned, %s: 401 UNAUTHENTICATED with a value-free log code, not 400/413/415', async (_label, url, send) => {
    const { app, worker, reconciler, lines } = harness();
    const response = await send(app, url);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(response.headers['retry-after']).toBeUndefined();
    const log = lines.join('');
    expect(log).toContain('CALLER_REJECTED');
    expect(log).toMatch(/"reason":"(BAD_FORMAT|MISSING_HEADER)"/);
    expect(log).not.toContain('xxxx');
    expect(worker.deliver).not.toHaveBeenCalled();
    expect(reconciler.run).not.toHaveBeenCalled();
    await app.close();
  });
  it('a framing failure on a request that carries a signature is 401 as well (it cannot be checked), and reaches no handler', async () => {
    const { app, worker } = harness();
    const body = 'x'.repeat(4097);
    const response = await post(app, '/internal/tasks', body, { 'upstash-signature': sign(body) });
    expect(response.statusCode).toBe(401);
    expect(worker.deliver).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('logs never carry the signature (PR #5 review F3, F4)', () => {
  type Logger = ReturnType<typeof createLogger>;
  const SIGNATURE = sign(BODY);
  const logged = (write: (log: Logger) => void) => {
    const lines: string[] = [];
    write(createLogger({ write: (line: string) => { lines.push(line); } }));
    return lines.join('');
  };
  it.each([
    ['top-level header name', (log: Logger) => log.info({ 'upstash-signature': SIGNATURE }, 'm')],
    ['req.headers (the req serializer already drops headers; the path is belt and braces)', (log: Logger) => log.info({ req: { headers: { 'upstash-signature': SIGNATURE } } }, 'm')],
    ['headers', (log: Logger) => log.info({ headers: { 'upstash-signature': SIGNATURE } }, 'm')],
    ['wildcard (one level down)', (log: Logger) => log.info({ request: { 'upstash-signature': SIGNATURE } }, 'm')],
  ])('redacts it: %s', (_label, write) => {
    const output = logged(write);
    if (!_label.startsWith('req.headers')) expect(output).toContain('[REDACTED]');
    expect(output).not.toContain(SIGNATURE);
    expect(output).not.toContain(SIGNATURE.split('.')[2]);
  });
  it('a verified delivery logs neither the token, its segments nor a key', async () => {
    const { app, lines } = harness();
    const body = JSON.stringify(payload());
    const token = sign(body);
    const response = await post(app, '/internal/tasks', body, { 'upstash-signature': token });
    expect(response.statusCode).toBe(200);
    const output = lines.join('');
    expect(output).toContain('Task delivery received');
    for (const part of [token, ...token.split('.'), KEY.current, KEY.next]) expect(output).not.toContain(part);
    await app.close();
  });
});

describe('verified bodies are parsed by the normal parser (PR #5 review F4)', () => {
  it('a non-canonical JSON body (whitespace, key order, newline), signed over its exact bytes, is parsed after verification', async () => {
    const { app, worker } = harness();
    const fields = payload();
    const body = `\n {\n  "seq" : ${fields.seq},"correlationId":"${fields.correlationId}",\n"tenantId" :"${fields.tenantId}", "requestId":"${fields.requestId}" }\n\n`;
    const response = await post(app, '/internal/tasks', body, { 'upstash-signature': sign(body) });
    expect(response.statusCode).toBe(200);
    expect(worker.deliver).toHaveBeenCalledWith(fields);
    await app.close();
  });
  it('the prototype-poisoning guard of the normal JSON parser still applies to verified bytes', async () => {
    const { app, worker } = harness();
    const fields = payload();
    const body = `{"__proto__":{"admin":true},"requestId":"${fields.requestId}","tenantId":"${fields.tenantId}","seq":1,"correlationId":"${fields.correlationId}"}`;
    const response = await post(app, '/internal/tasks', body, { 'upstash-signature': sign(body) });
    expect(response.statusCode).toBe(400);
    expect(worker.deliver).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('work finishing after QStash timed out stays safe (ADR-019, PR #5 review F5)', () => {
  // The decision itself is table-tested in the domain: packages/domain/test/reconcile-race.test.ts
  // ("two deliveries in flight at once: one lease, one 409; the retry after completion gets 200") and
  // scenarios.test.ts T5/T6. This drives the same sequence through the route with a worker that follows it.
  it('a retry during the held lease gets 409 + Retry-After 60; after the first delivery commits, a retry gets 200 DUPLICATE_SUPPRESSED', async () => {
    let committed = false;
    const { app, worker } = harness(async () => committed ? { http: 200, kind: 'DUPLICATE_SUPPRESSED' } : { http: 409, kind: 'LEASE_HELD' });
    const body = JSON.stringify(payload());
    const retry = () => post(app, '/internal/tasks', body, { 'upstash-signature': sign(body) });
    const during = await retry();
    expect(during.statusCode).toBe(409);
    expect(during.json()).toEqual({ code: 'LEASE_HELD' });
    expect(during.headers['retry-after']).toBe('60');
    committed = true;
    const after = await retry();
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual({ code: 'DUPLICATE_SUPPRESSED' });
    expect(after.headers['retry-after']).toBeUndefined();
    expect(worker.deliver).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
