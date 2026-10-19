import { z } from 'zod';

const integer = (fallback: number, max = 1_000_000) => z.coerce.number().int().positive().max(max).default(fallback);
const ConfigSchema = z.object({
  QP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GCLOUD_PROJECT: z.string().regex(/^[a-z][a-z0-9-]{4,62}$/).default('demo-queuepilot'),
  PORT: integer(8080, 65535),
  QP_MEMBERSHIP_CACHE_TTL: integer(30, 30),
  QP_INGEST_RPS_PER_INSTANCE: integer(40),
  QP_INGEST_MAX_INFLIGHT: integer(32),
  QP_MAX_BACKLOG: integer(20_000),
  QP_MAX_INSTANCES: integer(5),
  QP_QUOTA_FAILURE_MODE: z.enum(['closed', 'open']).default('closed'),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) throw new Error('Invalid API configuration');
  const config = parsed.data;
  if (config.QP_ENV === 'production') {
    if (config.QP_QUOTA_FAILURE_MODE === 'open' || Object.keys(env).some((key) => key.startsWith('QP_FAULT_'))) {
      throw new Error('Unsafe production configuration');
    }
    if (env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST || config.GCLOUD_PROJECT.startsWith('demo-')) {
      throw new Error('Production requires a real project and no emulator overrides');
    }
  }
  return config;
}
