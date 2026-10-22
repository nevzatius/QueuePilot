import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@queuepilot/core';
import { buildWorkerApp } from '../src/app.js';

// The worker is called by QStash, never by a browser, so it must not answer any CORS question, even when the
// shared configuration carries the API's allow-list.
const WEB = 'https://queuepilot-demo.web.app';

describe('the worker never sends CORS headers', () => {
  it('on probes, internal routes, unknown routes and preflights, whatever the shared QP_CORS_ORIGINS says', async () => {
    expect(loadConfig({ QP_ENV: 'test', QP_CORS_ORIGINS: WEB }).QP_CORS_ORIGINS).toEqual([WEB]);
    const app = buildWorkerApp({ verifier: { verify: async () => false }, store: { health: async () => {} } as never,
      worker: { deliver: vi.fn() } as never, reconciler: { run: vi.fn() } as never, logger: false });
    const requests = [
      { method: 'GET', url: '/health' }, { method: 'GET', url: '/ready' }, { method: 'POST', url: '/internal/tasks', payload: '{}' },
      { method: 'POST', url: '/internal/reconcile', payload: '' }, { method: 'GET', url: '/nope' },
    ] as const;
    for (const request of requests) {
      const response = await app.inject({ ...request, headers: { origin: WEB } });
      expect(Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
      expect(response.headers.vary).toBeUndefined();
    }
    const preflight = await app.inject({ method: 'OPTIONS', url: '/internal/tasks',
      headers: { origin: WEB, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
    expect(Object.keys(preflight.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    expect(preflight.statusCode).not.toBe(204);
    await app.close();
  });
});
