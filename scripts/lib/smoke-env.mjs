// Synthetic, production-shaped settings for the container smoke test (scripts/docker-smoke.mjs).
// No value is a credential or a reachable resource: the project does not exist, `.invalid` never resolves,
// Redis connects lazily and /health does no IO. tests/unit/smoke-env.test.ts parses these with the real
// loadConfig, so a drift from packages/core/src/config.ts fails the unit gate, not only the image job.

export const SMOKE_PROJECT = 'qp-ci-smoke';
const workerOrigin = 'https://qp-worker-123456789012.europe-west1.run.app';

export const PRODUCTION_ENV = Object.freeze({
  QP_ENV: 'production', GCLOUD_PROJECT: SMOKE_PROJECT, PORT: '8080',
  QP_WORKER_URL: workerOrigin, QP_TASKS_OIDC_AUDIENCE: workerOrigin,
  QP_TASKS_INVOKER_SA: `qp-tasks-invoker-sa@${SMOKE_PROJECT}.iam.gserviceaccount.com`,
  QP_SCHEDULER_SA: `qp-scheduler-sa@${SMOKE_PROJECT}.iam.gserviceaccount.com`,
  QP_REDIS_ENABLED: 'true', QP_QUOTA_FAILURE_MODE: 'closed', REDIS_URL: 'rediss://redis.invalid:6380',
});

/** Each variant must make startup fail with the given loadConfig message. */
export const FORBIDDEN_VARIANTS = Object.freeze([
  { label: 'quota fail-open in production', env: { QP_QUOTA_FAILURE_MODE: 'open' }, error: 'Unsafe production configuration' },
  { label: 'QP_FAULT_* flag in production', env: { QP_FAULT_SMOKE: '1' }, error: 'Unsafe production configuration' },
  { label: 'emulator override in production', env: { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, error: 'Production requires a real project and no emulator overrides' },
  { label: 'demo project in production', env: { GCLOUD_PROJECT: 'demo-queuepilot' }, error: 'Production requires a real project and no emulator overrides' },
]);
