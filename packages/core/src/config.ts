import { z } from 'zod';

const integer = (fallback: number, max = 1_000_000) => z.coerce.number().int().positive().max(max).default(fallback);
/**
 * Go-style duration WITH a unit, as QStash `Upstash-Timeout` requires: a bare number such as `60` is
 * answered with 400. The timeout must cover a Render free cold start (up to about 50 s per Render docs,
 * 8-14 s measured in the ADR-019 spike) plus the processing itself, or QStash aborts and retries a
 * delivery that is still starting up.
 */
const GO_DURATION = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/;
/**
 * Bounds for QP_QSTASH_TIMEOUT. Lower: covers the Render free cold start (8-14 s measured, up to about
 * 50 s documented) plus processing. Upper: QStash's documented maximum HTTP timeout. The free-plan
 * maximum for the Upstash-Timeout header is NOT verified yet (open B9-2 live check).
 */
export const QSTASH_TIMEOUT_MIN_MS = 60_000;
export const QSTASH_TIMEOUT_MAX_MS = 15 * 60_000;
const DURATION_UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
/** Go duration (already matched by GO_DURATION) to milliseconds. */
export function parseGoDurationMs(value: string): number {
  let total = 0;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) total += Number(amount) * DURATION_UNIT_MS[unit!]!;
  return total;
}
const withinTimeoutBounds = (value: string) => {
  const ms = parseGoDurationMs(value);
  return ms >= QSTASH_TIMEOUT_MIN_MS && ms <= QSTASH_TIMEOUT_MAX_MS;
};
const QSTASH_VARS = ['QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY'] as const;
const QSTASH_OPTIONAL_VARS = ['QP_QSTASH_RETRIES', 'QP_QSTASH_TIMEOUT', 'QSTASH_URL'] as const;
/** QStash tokens are regional; the default is the global endpoint. Not a secret, but never echoed from an invalid value. */
export const QSTASH_DEFAULT_URL = 'https://qstash.upstash.io';
/** True for an https origin with no credentials, path, query or fragment (URL.origin drops all of those). */
export function isHttpsOrigin(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === 'https:' && new URL(value).origin === value;
}
/** The shared check for QP_QSTASH_TIMEOUT, used by config and by the adapter constructor. */
export function isQStashTimeout(value: string): boolean {
  return GO_DURATION.test(value) && withinTimeoutBounds(value);
}
const CLOUD_TASKS_VARS = ['QP_TASKS_INVOKER_SA', 'QP_TASKS_OIDC_AUDIENCE', 'QP_SCHEDULER_SA', 'QP_REGION', 'QP_TASKS_QUEUE'] as const;
/** Config keys whose values are credentials. Never log, dump or put them in an error. */
export const SECRET_CONFIG_KEYS = [...QSTASH_VARS, 'REDIS_URL'] as const;
const isSet = (value: string | undefined) => value !== undefined && value.trim() !== '';

const ConfigSchema = z.object({
  QP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GCLOUD_PROJECT: z.string().regex(/^[a-z][a-z0-9-]{4,62}$/).default('demo-queuepilot'),
  PORT: integer(8080, 65535),
  QP_QUEUE_ADAPTER: z.enum(['local', 'cloud', 'qstash']).optional(),
  QP_REGION: z.string().regex(/^[a-z]+-[a-z]+\d+$/).default('europe-west1'),
  QP_TASKS_QUEUE: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).default('qp-process'),
  QP_TASKS_INVOKER_SA: z.email().optional(),
  QP_SCHEDULER_SA: z.email().optional(),
  QP_WORKER_URL: z.url().default('http://127.0.0.1:18281'),
  QP_TASKS_OIDC_AUDIENCE: z.url().optional(),
  // `qstash` is the default under the qstash adapter (see loadConfig); `oidc` otherwise.
  QP_WORKER_AUTH_MODE: z.enum(['oidc', 'local', 'qstash']).default('oidc'),
  QP_TASK_DISPATCH_DEADLINE_SECONDS: z.coerce.number().int().min(15).max(30).default(30),
  QP_RECONCILER_SHARDS: z.coerce.number().int().min(4).max(4).default(4),
  QP_RECONCILE_LIMIT_PER_SHARD: integer(25, 25),
  QP_MEMBERSHIP_CACHE_TTL: integer(30, 30),
  QP_INGEST_RPS_PER_INSTANCE: integer(40),
  QP_INGEST_MAX_INFLIGHT: integer(32),
  QP_MAX_BACKLOG: integer(20_000),
  QP_MAX_INSTANCES: integer(5),
  REDIS_URL: z.url().refine((value) => URL.canParse(value) && ['redis:', 'rediss:'].includes(new URL(value).protocol)).default('redis://127.0.0.1:6379'),
  QP_REDIS_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  QP_QUOTA_FAILURE_MODE: z.enum(['closed', 'open']).default('closed'),
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),
  // A regex, not z.coerce: an empty string would coerce to 0 retries silently.
  QP_QSTASH_RETRIES: z.string().regex(/^[0-3]$/).default('2').transform(Number),
  QP_QSTASH_TIMEOUT: z.string().regex(GO_DURATION).refine(withinTimeoutBounds).default('90s'),
  // Checked in loadConfig, not with z.url(): a failure there must not carry the raw value.
  QSTASH_URL: z.string().default(QSTASH_DEFAULT_URL),
});
export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // A refine that throws would carry the raw input (possibly a credential URL) in the error; never forward it.
  let parsed: ReturnType<typeof ConfigSchema.safeParse>;
  try { parsed = ConfigSchema.safeParse(env); } catch { throw new Error('Invalid API configuration'); }
  if (!parsed.success) throw new Error('Invalid API configuration');
  const config = parsed.data;
  config.QP_QUEUE_ADAPTER ??= config.QP_ENV === 'production' ? 'cloud' : 'local';
  if (!URL.canParse(config.QP_WORKER_URL)) throw new Error('Invalid API configuration');
  const workerUrl = new URL(config.QP_WORKER_URL);
  if (workerUrl.origin !== config.QP_WORKER_URL) {
    throw new Error('Worker URL must be an origin');
  }
  if (!isHttpsOrigin(config.QSTASH_URL)) throw new Error('QSTASH_URL must be an https origin');
  if (config.QP_QUEUE_ADAPTER === 'cloud' && (!config.QP_TASKS_INVOKER_SA || !config.QP_TASKS_OIDC_AUDIENCE
      || workerUrl.protocol !== 'https:' || config.QP_TASKS_OIDC_AUDIENCE !== config.QP_WORKER_URL)) {
    throw new Error('Cloud queue requires HTTPS worker origin, matching audience and invoker service account');
  }
  if (config.QP_QUEUE_ADAPTER === 'qstash') {
    const missing = QSTASH_VARS.filter((key) => !isSet(config[key]));
    if (missing.length > 0) throw new Error(`QStash queue requires ${missing.join(', ')}`);
    if (workerUrl.protocol !== 'https:' && config.QP_ENV === 'production') {
      throw new Error('QStash queue requires an HTTPS worker origin in production');
    }
  }
  // The HMAC uses the key as given, so a stray newline or space from a pasted secret must fail loudly. Names only, never a value.
  // Only under qstash, where the keys are used (blank foreign values under another backend stay ignored, see the mixed-config tests).
  for (const key of ['QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY'] as const) {
    const value = config[key];
    if (config.QP_QUEUE_ADAPTER === 'qstash' && value !== undefined && value !== value.trim()) throw new Error(`${key} must not have leading or trailing whitespace`);
  }
  // The auth mode follows the queue backend: qstash <-> qstash, cloud/local <-> oidc (or local, checked below).
  if (!isSet(env.QP_WORKER_AUTH_MODE) && config.QP_QUEUE_ADAPTER === 'qstash') config.QP_WORKER_AUTH_MODE = 'qstash';
  if (config.QP_WORKER_AUTH_MODE === 'local' && (config.QP_ENV === 'production' || config.QP_QUEUE_ADAPTER !== 'local'
      || !/^(localhost|127\.0\.0\.1):\d+$/.test(env.FIRESTORE_EMULATOR_HOST ?? '')
      || !config.GCLOUD_PROJECT.startsWith('demo-'))) {
    throw new Error('Local worker auth requires a local emulator and demo project');
  }
  // Constant message: no value, so a mistyped secret cannot end up in it. Local mode was already settled above.
  if (config.QP_WORKER_AUTH_MODE !== 'local' && (config.QP_WORKER_AUTH_MODE === 'qstash') !== (config.QP_QUEUE_ADAPTER === 'qstash')) {
    throw new Error('Worker auth mode does not match the queue backend');
  }
  if (config.QP_ENV === 'production') {
    if (config.QP_QUEUE_ADAPTER === 'local' || config.QP_WORKER_AUTH_MODE === 'local'
        || config.QP_QUOTA_FAILURE_MODE === 'open' || Object.keys(env).some((key) => key.startsWith('QP_FAULT_'))) {
      throw new Error('Unsafe production configuration');
    }
    if (new URL(config.REDIS_URL).protocol !== 'rediss:') throw new Error('Production requires a TLS Redis URL (rediss:)');
    const foreign: readonly string[] = config.QP_QUEUE_ADAPTER === 'qstash' ? CLOUD_TASKS_VARS : [...QSTASH_VARS, ...QSTASH_OPTIONAL_VARS];
    if (foreign.some((key) => isSet(env[key]))) {
      throw new Error('Ambiguous production configuration: queue backend settings are mixed');
    }
    if (env.FIRESTORE_EMULATOR_HOST || env.FIREBASE_AUTH_EMULATOR_HOST || config.GCLOUD_PROJECT.startsWith('demo-')) {
      throw new Error('Production requires a real project and no emulator overrides');
    }
  }
  return config;
}

/** Config safe to log or dump: credentials are replaced, everything else is unchanged. */
export function redactConfig(config: Config): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...config };
  for (const key of SECRET_CONFIG_KEYS) if (copy[key] !== undefined) copy[key] = '[REDACTED]';
  return copy;
}
