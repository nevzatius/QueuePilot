import { describe, expect, it } from 'vitest';
import { HEADERS } from '@queuepilot/contracts';
import { CORS_ALLOWED_HEADERS, CORS_ALLOWED_METHODS, CORS_EXPOSED_HEADERS, CORS_MAX_AGE_SECONDS } from '../src/cors.js';
import { edgeApp } from './edge-fixture.js';

const WEB = 'https://queuepilot-demo.web.app';
const OTHER_WEB = 'https://queuepilot-demo.firebaseapp.com';
const LIST = `${WEB},${OTHER_WEB}`;
const acHeaders = (headers: Record<string, unknown>) => Object.keys(headers).filter((name) => name.startsWith('access-control-'));
const preflight = (app: ReturnType<typeof edgeApp>['app'], origin: string | undefined, extra: Record<string, string> = {}) => app.inject({
  method: 'OPTIONS', url: '/api/v1/requests',
  headers: { ...(origin !== undefined && { origin }), 'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization,content-type,idempotency-key', ...extra },
});

describe('CORS allow-list', () => {
  it('answers an allowed origin with exactly that origin, Vary: Origin and the exposed headers, never credentials', async () => {
    const { app } = edgeApp({ QP_CORS_ORIGINS: LIST });
    for (const origin of [WEB, OTHER_WEB]) {
      const response = await app.inject({ url: '/health', headers: { origin } });
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers.vary).toBe('Origin');
      expect(response.headers['access-control-expose-headers']).toBe(CORS_EXPOSED_HEADERS);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    }
    await app.close();
  });
  it('exposes Retry-After, and the other response headers the web client reads', () => {
    const exposed = CORS_EXPOSED_HEADERS.toLowerCase().split(', ');
    expect(exposed).toEqual(expect.arrayContaining([HEADERS.retryAfter, HEADERS.idempotentReplayed, HEADERS.correlationId, HEADERS.location]));
  });
  it.each([
    ['another site', 'https://evil.example.test'],
    ['a suffix attack', `${WEB}.evil.example.test`],
    ['a prefix attack', `https://evil.${WEB.slice('https://'.length)}`],
    ['the http twin', WEB.replace('https:', 'http:')],
    ['another port', `${WEB}:8443`],
    ['a trailing slash', `${WEB}/`],
    ['another letter case', WEB.toUpperCase()],
    ['the literal null origin', 'null'],
    ['a wildcard', '*'],
    ['localhost (not listed)', 'http://localhost:5173'],
  ])('gives %s no CORS headers (never an echo, never *), but still Vary: Origin', async (_label, origin) => {
    const { app } = edgeApp({ QP_CORS_ORIGINS: LIST });
    const response = await app.inject({ url: '/health', headers: { origin } });
    expect(acHeaders(response.headers)).toEqual([]);
    expect(response.headers.vary).toBe('Origin');
    await app.close();
  });
  it('sends no CORS headers without an Origin header, and an empty list means no cross-origin access at all', async () => {
    const { app } = edgeApp({ QP_CORS_ORIGINS: LIST });
    const plain = await app.inject({ url: '/health' });
    expect(acHeaders(plain.headers)).toEqual([]);
    expect(plain.headers.vary).toBe('Origin');
    await app.close();
    for (const env of [{}, { QP_CORS_ORIGINS: '' }, { QP_CORS_ORIGINS: '  ' }]) {
      const empty = edgeApp(env).app;
      const get = await empty.inject({ url: '/health', headers: { origin: WEB } });
      const pre = await preflight(empty, WEB);
      expect(acHeaders(get.headers)).toEqual([]);
      expect(acHeaders(pre.headers)).toEqual([]);
      await empty.close();
    }
  });
  it('answers a preflight of an allowed origin with 204, the real methods and headers, a modest max-age and no credentials', async () => {
    const { app, verifier } = edgeApp({ QP_CORS_ORIGINS: LIST });
    const response = await preflight(app, WEB);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['access-control-allow-origin']).toBe(WEB);
    expect(response.headers['access-control-allow-methods']).toBe(CORS_ALLOWED_METHODS);
    expect(response.headers['access-control-allow-headers']).toBe(CORS_ALLOWED_HEADERS);
    expect(response.headers['access-control-max-age']).toBe(String(CORS_MAX_AGE_SECONDS));
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers.vary).toBe('Origin');
    expect(verifier.verify).not.toHaveBeenCalled();
    await app.close();
  });
  it('lists exactly the methods and request headers the API reads', () => {
    expect(CORS_ALLOWED_METHODS.split(', ').sort()).toEqual(['GET', 'OPTIONS', 'POST']);
    expect(CORS_ALLOWED_HEADERS.toLowerCase().split(', ').sort()).toEqual(['authorization', 'content-type', HEADERS.idempotencyKey].sort());
    expect(CORS_MAX_AGE_SECONDS).toBeLessThanOrEqual(3600);
  });
  it('does not echo the requested headers or method from the preflight', async () => {
    const { app } = edgeApp({ QP_CORS_ORIGINS: LIST });
    const response = await preflight(app, WEB, { 'access-control-request-headers': 'x-evil, authorization', 'access-control-request-method': 'DELETE' });
    expect(response.headers['access-control-allow-headers']).toBe(CORS_ALLOWED_HEADERS);
    expect(response.headers['access-control-allow-methods']).not.toContain('DELETE');
    await app.close();
  });
  it('gives a preflight of an unlisted origin no CORS headers at all, and never reaches authentication', async () => {
    const { app, verifier } = edgeApp({ QP_CORS_ORIGINS: LIST });
    for (const origin of ['https://evil.example.test', 'null', '*']) {
      const response = await preflight(app, origin);
      expect(response.statusCode).toBe(204);
      expect(acHeaders(response.headers)).toEqual([]);
    }
    expect(verifier.verify).not.toHaveBeenCalled();
    await app.close();
  });
  it('treats OPTIONS without Origin as an ordinary request (authenticated like any other)', async () => {
    const { app } = edgeApp({ QP_CORS_ORIGINS: LIST });
    const response = await preflight(app, undefined);
    expect(response.statusCode).toBe(401);
    expect(acHeaders(response.headers)).toEqual([]);
    await app.close();
  });
  it('keeps the CORS headers on error answers, so the browser can read the 401 and 404', async () => {
    const { app } = edgeApp({ QP_CORS_ORIGINS: LIST });
    const unauthenticated = await app.inject({ url: '/api/v1/me', headers: { origin: WEB } });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['access-control-allow-origin']).toBe(WEB);
    expect(unauthenticated.headers['access-control-expose-headers']).toContain(HEADERS.retryAfter);
    const missing = await app.inject({ url: '/nope', headers: { origin: WEB, authorization: 'Bearer valid' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['access-control-allow-origin']).toBe(WEB);
    const foreign = await app.inject({ url: '/nope', headers: { origin: 'https://evil.example.test', authorization: 'Bearer valid' } });
    expect(acHeaders(foreign.headers)).toEqual([]);
    await app.close();
  });
  it('is no authentication: an unlisted origin with a valid token is still served, just without CORS headers', async () => {
    const { app } = edgeApp({ QP_CORS_ORIGINS: LIST });
    const response = await app.inject({ url: '/api/v1/me', headers: { origin: 'https://evil.example.test', authorization: 'Bearer valid' } });
    expect(response.statusCode).toBe(200);
    expect(acHeaders(response.headers)).toEqual([]);
    await app.close();
  });
});
