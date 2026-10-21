import { describe, expect, it, vi } from 'vitest';
import { createCallerVerifier, loadConfig, OidcCallerVerifier } from '@queuepilot/core';
import type { VerifyIdToken } from '@queuepilot/core';

const audience = 'https://worker.example.test';
const taskEmail = 'qp-tasks-invoker-sa@qp-test-project.iam.gserviceaccount.com';
const schedulerEmail = 'qp-scheduler-sa@qp-test-project.iam.gserviceaccount.com';
const config = () => loadConfig({ QP_ENV: 'production', GCLOUD_PROJECT: 'qp-test-project',
  QP_WORKER_URL: audience, QP_TASKS_OIDC_AUDIENCE: audience, QP_TASKS_INVOKER_SA: taskEmail, REDIS_URL: 'rediss://redis.invalid:6380' });

describe('private worker caller verification', () => {
  it('rejects missing/malformed auth without touching token verifier', async () => {
    const verify = vi.fn<VerifyIdToken>();
    const auth = new OidcCallerVerifier(config(), verify);
    for (const header of [undefined, '', 'Basic abc', 'Bearer ', 'Bearer a b']) expect(await auth.verify(header, 'tasks')).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it('uses cryptographic verifier with audience; scopes service accounts by endpoint', async () => {
    const verify = vi.fn<VerifyIdToken>(async () => ({ aud: audience, email: taskEmail, email_verified: true, iss: 'https://accounts.google.com' }));
    const auth = new OidcCallerVerifier(config(), verify);
    expect(await auth.verify('Bearer signed-token', 'tasks')).toBe(true);
    expect(verify).toHaveBeenCalledWith('signed-token', audience);
    expect(await auth.verify('Bearer signed-token', 'scheduler')).toBe(false);
    verify.mockResolvedValue({ aud: audience, email: schedulerEmail, email_verified: true, iss: 'accounts.google.com' });
    expect(await auth.verify('Bearer signed-token', 'scheduler')).toBe(true);
    expect(await auth.verify('Bearer signed-token', 'tasks')).toBe(false);
  });
  it.each([{ email: 'foreign@example.test' }, { email_verified: false }, { aud: 'https://foreign.test' }, { iss: 'foreign' }])(
    'rejects invalid claims %j', async (patch) => {
      const auth = new OidcCallerVerifier(config(), async () => ({ aud: audience, email: taskEmail, email_verified: true, iss: 'https://accounts.google.com', ...patch }));
      expect(await auth.verify('Bearer token', 'tasks')).toBe(false);
    });
  it('fails closed on bad signatures, expired tokens or verification network failure', async () => {
    const auth = new OidcCallerVerifier(config(), async () => { throw new Error('invalid signature or expired'); });
    expect(await auth.verify('Bearer token', 'tasks')).toBe(false);
    expect(() => createCallerVerifier({ ...config(), QP_WORKER_AUTH_MODE: 'local' })).toThrow();
  });
});
