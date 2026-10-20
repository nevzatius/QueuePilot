import { describe, expect, it } from 'vitest';
import { loadConfig } from '@queuepilot/core';
import { FORBIDDEN_VARIANTS, PRODUCTION_ENV } from '../../scripts/lib/smoke-env.mjs';

// The container smoke must use values the real config schema accepts, and each "must refuse"
// variant must be refused by loadConfig for the reason the smoke test greps for.
describe('container smoke environment', () => {
  it('is accepted by loadConfig as a production cloud configuration', () => {
    const config = loadConfig({ ...PRODUCTION_ENV });
    expect(config).toMatchObject({ QP_ENV: 'production', QP_QUEUE_ADAPTER: 'cloud', QP_WORKER_AUTH_MODE: 'oidc', QP_QUOTA_FAILURE_MODE: 'closed', PORT: 8080 });
    expect(config.QP_TASKS_OIDC_AUDIENCE).toBe(config.QP_WORKER_URL);
  });

  it.each(FORBIDDEN_VARIANTS)('refuses $label', ({ env, error }) => {
    expect(() => loadConfig({ ...PRODUCTION_ENV, ...env })).toThrow(error);
  });
});
