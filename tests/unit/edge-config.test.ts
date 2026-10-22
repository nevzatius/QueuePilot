import { describe, expect, it } from 'vitest';
import {
  CORS_ORIGINS_MAX, loadConfig, REDIS_CONNECT_TIMEOUT_DEFAULT_MS, REDIS_CONNECT_TIMEOUT_MAX_MS, REDIS_CONNECT_TIMEOUT_MIN_MS,
} from '@queuepilot/core';

const WEB = 'https://queuepilot-demo.web.app';
const PRODUCTION: Record<string, string> = { QP_ENV: 'production', GCLOUD_PROJECT: 'real-project', QP_QUEUE_ADAPTER: 'cloud',
  QP_WORKER_URL: 'https://worker.example.test', QP_TASKS_OIDC_AUDIENCE: 'https://worker.example.test',
  QP_TASKS_INVOKER_SA: 'worker@real-project.iam.gserviceaccount.com', REDIS_URL: 'rediss://redis.invalid:6380' };
const CORS_MESSAGE = 'QP_CORS_ORIGINS must be exact https origins (http://localhost and http://127.0.0.1 only outside production)';
const dev = (env: Record<string, string>) => loadConfig({ QP_ENV: 'test', ...env });

describe('QP_CORS_ORIGINS', () => {
  it('defaults to an empty list (no cross-origin access), in production too', () => {
    expect(dev({}).QP_CORS_ORIGINS).toEqual([]);
    expect(loadConfig(PRODUCTION).QP_CORS_ORIGINS).toEqual([]);
    expect(dev({ QP_CORS_ORIGINS: '   ' }).QP_CORS_ORIGINS).toEqual([]);
  });
  it('accepts exact https origins, comma separated, with spaces around the commas', () => {
    expect(dev({ QP_CORS_ORIGINS: `${WEB}, https://queuepilot-demo.firebaseapp.com ,https://example.test:8443` }).QP_CORS_ORIGINS)
      .toEqual([WEB, 'https://queuepilot-demo.firebaseapp.com', 'https://example.test:8443']);
    expect(loadConfig({ ...PRODUCTION, QP_CORS_ORIGINS: WEB }).QP_CORS_ORIGINS).toEqual([WEB]);
  });
  it.each([
    ['a wildcard', '*'], ['a wildcard subdomain', 'https://*.web.app'], ['a wildcard inside a list', `${WEB},*`],
    ['a path', `${WEB}/app`], ['a trailing slash', `${WEB}/`], ['userinfo', 'https://user:pw@queuepilot-demo.web.app'],
    ['a query', `${WEB}?a=1`], ['a fragment', `${WEB}#x`], ['no scheme', 'queuepilot-demo.web.app'], ['plain http', 'http://queuepilot-demo.web.app'],
    ['other schemes', 'ftp://queuepilot-demo.web.app'], ['an upper-case host', 'https://QueuePilot-Demo.web.app'], ['the default port spelled out', `${WEB}:443`],
    ['an empty entry', `${WEB},,https://example.test`], ['a trailing comma', `${WEB},`], ['a space inside', 'https://queuepilot demo.web.app'],
    ['the literal null', 'null'], ['a local origin with a path', 'http://localhost:5173/'], ['a look-alike local host', 'http://localhost.evil.example.test'],
    ['another loopback spelling', 'http://[::1]:5173'], ['too many entries', Array.from({ length: CORS_ORIGINS_MAX + 1 }, (_, i) => `https://o${i}.example.test`).join(',')],
  ])('rejects %s with a constant, value-free message', (_label, value) => {
    expect(() => dev({ QP_CORS_ORIGINS: value })).toThrow(CORS_MESSAGE);
    try { dev({ QP_CORS_ORIGINS: value }); } catch (error) { expect(String(error)).not.toContain('queuepilot'); expect(String(error)).not.toContain('pw'); }
  });
  it.each(['http://localhost', 'http://localhost:5173', 'http://127.0.0.1', 'http://127.0.0.1:4173'])('allows %s outside production', (origin) => {
    expect(dev({ QP_CORS_ORIGINS: origin }).QP_CORS_ORIGINS).toEqual([origin]);
    expect(loadConfig({ QP_ENV: 'development', QP_CORS_ORIGINS: `${WEB},${origin}` }).QP_CORS_ORIGINS).toEqual([WEB, origin]);
  });
  it('accepts exactly CORS_ORIGINS_MAX origins and rejects one more', () => {
    const list = (count: number) => Array.from({ length: count }, (_, i) => `https://o${i}.example.test`);
    expect(dev({ QP_CORS_ORIGINS: list(CORS_ORIGINS_MAX).join(',') }).QP_CORS_ORIGINS).toHaveLength(CORS_ORIGINS_MAX);
    expect(CORS_ORIGINS_MAX).toBe(10);
    expect(() => dev({ QP_CORS_ORIGINS: list(CORS_ORIGINS_MAX + 1).join(',') })).toThrow(CORS_MESSAGE);
  });
  it.each(['https://localhost', 'https://localhost:5173', 'https://127.0.0.1', 'https://127.5.4.3:8443', 'https://[::1]', 'https://[::1]:8443', 'https://app.localhost'])(
    'rejects the loopback host %s in production', (origin) => {
      expect(() => loadConfig({ ...PRODUCTION, QP_CORS_ORIGINS: origin })).toThrow(CORS_MESSAGE);
      expect(() => loadConfig({ ...PRODUCTION, QP_CORS_ORIGINS: `${WEB},${origin}` })).toThrow(CORS_MESSAGE);
    });
  it('keeps https loopback hosts valid outside production', () => {
    for (const origin of ['https://localhost', 'https://127.5.4.3:8443']) expect(dev({ QP_CORS_ORIGINS: origin }).QP_CORS_ORIGINS).toEqual([origin]);
  });
  it('rejects a duplicate entry in production; outside production the list is unchanged', () => {
    expect(() => loadConfig({ ...PRODUCTION, QP_CORS_ORIGINS: `${WEB},${WEB}` })).toThrow(CORS_MESSAGE);
    expect(() => loadConfig({ ...PRODUCTION, QP_CORS_ORIGINS: `${WEB}, https://other.example.test ,${WEB}` })).toThrow(CORS_MESSAGE);
    expect(dev({ QP_CORS_ORIGINS: `${WEB},${WEB}` }).QP_CORS_ORIGINS).toEqual([WEB, WEB]);
    expect(loadConfig({ ...PRODUCTION, QP_CORS_ORIGINS: `${WEB},https://other.example.test` }).QP_CORS_ORIGINS).toHaveLength(2);
  });
  it.each(['http://localhost', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://queuepilot-demo.web.app'])('rejects %s in production', (origin) => {
    expect(() => loadConfig({ ...PRODUCTION, QP_CORS_ORIGINS: origin })).toThrow(CORS_MESSAGE);
    expect(() => loadConfig({ ...PRODUCTION, QP_CORS_ORIGINS: `${WEB},${origin}` })).toThrow(CORS_MESSAGE);
  });
});

describe('TRUST_PROXY_HOPS', () => {
  it('defaults to 0 and accepts the integers 0 to 5', () => {
    expect(dev({}).TRUST_PROXY_HOPS).toBe(0);
    for (const hops of [0, 1, 2, 3, 4, 5]) expect(dev({ TRUST_PROXY_HOPS: String(hops) }).TRUST_PROXY_HOPS).toBe(hops);
  });
  it.each(['true', 'false', 'yes', '-1', '6', '10', '3.0', '3.5', '1e1', '0x3', '03', ' 3', '3 ', '', 'three', 'Infinity', 'NaN'])('rejects %j', (value) => {
    expect(() => dev({ TRUST_PROXY_HOPS: value })).toThrow('Invalid API configuration');
    expect(() => loadConfig({ ...PRODUCTION, TRUST_PROXY_HOPS: value })).toThrow('Invalid API configuration');
  });
  it('is accepted in production (3 is the Render value)', () => {
    expect(loadConfig({ ...PRODUCTION, TRUST_PROXY_HOPS: '3' }).TRUST_PROXY_HOPS).toBe(3);
  });
});

describe('QP_REDIS_CONNECT_TIMEOUT_MS', () => {
  it('defaults to 1500 ms: inside 1500-2000, about 3.7x the measured cold connect (about 404 ms)', () => {
    expect(REDIS_CONNECT_TIMEOUT_DEFAULT_MS).toBeGreaterThanOrEqual(1500);
    expect(REDIS_CONNECT_TIMEOUT_DEFAULT_MS).toBeLessThanOrEqual(2000);
    expect(dev({}).QP_REDIS_CONNECT_TIMEOUT_MS).toBe(REDIS_CONNECT_TIMEOUT_DEFAULT_MS);
    expect(loadConfig(PRODUCTION).QP_REDIS_CONNECT_TIMEOUT_MS).toBe(REDIS_CONNECT_TIMEOUT_DEFAULT_MS);
  });
  it('accepts the documented bounds and values between', () => {
    for (const ms of [REDIS_CONNECT_TIMEOUT_MIN_MS, 400, 2000, REDIS_CONNECT_TIMEOUT_MAX_MS]) {
      expect(dev({ QP_REDIS_CONNECT_TIMEOUT_MS: String(ms) }).QP_REDIS_CONNECT_TIMEOUT_MS).toBe(ms);
    }
  });
  it.each(['0', '99', '3001', '60000', '-1', '1500.5', '1.5e3', '', ' 1500', 'fast', 'true', '100000'])('rejects %j', (value) => {
    expect(() => dev({ QP_REDIS_CONNECT_TIMEOUT_MS: value })).toThrow(/Invalid API configuration|QP_REDIS_CONNECT_TIMEOUT_MS is out of range/);
  });
  // Documentation only: pure arithmetic on the constants. The real guard is the fake-timer test
  // "bounds the whole Redis-down request path" in redis.test.ts.
  it('documents the worst Redis-down request budget against the 15 s API timeout (rate limiter, then quota)', () => {
    const COMMAND_MS = 100;
    expect(2 * (REDIS_CONNECT_TIMEOUT_DEFAULT_MS + COMMAND_MS)).toBeLessThan(5_000);
    expect(2 * (REDIS_CONNECT_TIMEOUT_MAX_MS + COMMAND_MS)).toBeLessThan(15_000 / 2);
  });
});
