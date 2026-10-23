import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';

const integer = (fallback: number, max = 1_000_000) => z.coerce.number().int().positive().max(max).default(fallback);
/**
 * `<number><unit>` with ONE unit s, m or h, which is the format the QStash API documents for `Upstash-Timeout`
 * (create-a-schedule and publish pages). A bare number such as `60` is answered with 400, and compound or
 * fractional Go durations (`1m30s`, `1.5s`, `90000ms`) are not documented, so they are rejected rather than
 * trusted. The timeout must cover a Render free cold start (up to about 50 s per Render docs, 8-14 s measured
 * in the ADR-019 spike) plus the processing itself, or QStash aborts and retries a delivery that is still starting up.
 */
const QSTASH_DURATION = /^\d+[smh]$/;
/**
 * Bounds for QP_QSTASH_TIMEOUT. Lower: covers the Render free cold start (8-14 s measured, up to about
 * 50 s documented) plus processing. Upper: QStash's documented maximum HTTP timeout. The free-plan
 * maximum for the Upstash-Timeout header is NOT verified yet (open B9-2 live check).
 */
export const QSTASH_TIMEOUT_MIN_MS = 60_000;
export const QSTASH_TIMEOUT_MAX_MS = 15 * 60_000;
const DURATION_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };
/** A `<number><s|m|h>` duration (already matched by QSTASH_DURATION) to milliseconds. */
export function parseGoDurationMs(value: string): number {
  return Number(value.slice(0, -1)) * DURATION_UNIT_MS[value.slice(-1)]!;
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
  return QSTASH_DURATION.test(value) && withinTimeoutBounds(value);
}
/**
 * Redis connect timeout bounds (QP_REDIS_CONNECT_TIMEOUT_MS). Measured on Upstash free (ADR-019 spike, small
 * sample): cold TCP/TLS connect about 404 ms, warm 24-40 ms, commands about 2 ms. The old fixed 100 ms made every
 * cold start fail closed. Default 1500 ms is about 3.7x the cold measurement and keeps the worst Redis-down
 * request (rate limiter, then quota, each connect + 100 ms command) near 3.2 s, well inside the 15 s API timeout.
 * Max 3000 ms keeps that worst case near 6.2 s. Min 100 ms is the previous value.
 */
export const REDIS_CONNECT_TIMEOUT_DEFAULT_MS = 1500;
export const REDIS_CONNECT_TIMEOUT_MIN_MS = 100;
export const REDIS_CONNECT_TIMEOUT_MAX_MS = 3000;
/** More entries than any deployment needs; a long list is a misconfiguration. */
export const CORS_ORIGINS_MAX = 10;
/** Exact development origins; any port. Never accepted in production. */
const LOCAL_ORIGIN_HOSTS = ['localhost', '127.0.0.1'];
/** localhost, 127.0.0.0/8 and [::1]; the URL parser has already canonicalised numeric spellings. */
const isLoopbackHost = (hostname: string) => hostname === 'localhost' || hostname.endsWith('.localhost')
  || /^127\.\d+\.\d+\.\d+$/.test(hostname) || hostname === '[::1]';
/** A CORS entry: an exact https origin, or (outside production) an exact http://localhost or http://127.0.0.1 origin. */
export function isCorsOrigin(value: string, production: boolean): boolean {
  if (value.includes('*') || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.origin !== value) return false;
  if (url.protocol === 'https:') return !(production && isLoopbackHost(url.hostname));
  return !production && url.protocol === 'http:' && LOCAL_ORIGIN_HOSTS.includes(url.hostname);
}
const CLOUD_TASKS_VARS = ['QP_TASKS_INVOKER_SA', 'QP_TASKS_OIDC_AUDIENCE', 'QP_SCHEDULER_SA', 'QP_REGION', 'QP_TASKS_QUEUE'] as const;
/** Config keys whose values are credentials. Never log, dump or put them in an error. */
export const SECRET_CONFIG_KEYS = [...QSTASH_VARS, 'REDIS_URL', 'QP_FIREBASE_SERVICE_ACCOUNT_JSON'] as const;
const isSet = (value: string | undefined) => value !== undefined && value.trim() !== '';

/** The three fields of a Firebase service-account key that the Admin SDK needs. The key itself never leaves the process. */
export interface FirebaseServiceAccount { projectId: string; clientEmail: string; privateKey: string }
const SERVICE_ACCOUNT_EMAIL = /^[A-Za-z0-9._-]+@[a-z][a-z0-9-]*\.iam\.gserviceaccount\.com$/;
const PRIVATE_KEY = /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/;
/**
 * Why a service-account JSON is unusable, as a category only (never a fragment of the input), or undefined when it is usable.
 * JSON.parse errors quote a slice of their input, so they are swallowed here.
 */
function serviceAccountProblem(raw: string, projectId: string): 'invalid_json' | 'project_mismatch' | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return 'invalid_json'; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'invalid_json';
  const { type, project_id: keyProject, client_email: clientEmail, private_key: privateKey } = value as Record<string, unknown>;
  if (type !== 'service_account' || typeof clientEmail !== 'string' || !SERVICE_ACCOUNT_EMAIL.test(clientEmail)
      || typeof privateKey !== 'string' || !PRIVATE_KEY.test(privateKey)) return 'invalid_json';
  if (keyProject !== projectId) return 'project_mismatch';
  // A PEM with the right markers and a corrupted body would otherwise pass here and fail on the first Firestore call.
  try { createPrivateKey(privateKey); } catch { return 'invalid_json'; }
  return undefined;
}
/**
 * Parses and validates QP_FIREBASE_SERVICE_ACCOUNT_JSON for `projectId`. The ONLY place the raw JSON is interpreted.
 * Every failure is the same constant message: a rejected key (or a typo of one) must never end up in a log.
 */
export function parseServiceAccount(raw: string, projectId: string): FirebaseServiceAccount {
  if (serviceAccountProblem(raw, projectId)) throw new Error('QP_FIREBASE_SERVICE_ACCOUNT_JSON is invalid');
  const { client_email: clientEmail, private_key: privateKey } = JSON.parse(raw) as Record<string, string>;
  return { projectId, clientEmail: clientEmail!, privateKey: privateKey! };
}
/** The configured service account, or undefined when none is set (the SDK then falls back to ambient credentials). */
export function configuredServiceAccount(config: Pick<Config, 'GCLOUD_PROJECT' | 'QP_FIREBASE_SERVICE_ACCOUNT_JSON'>): FirebaseServiceAccount | undefined {
  const raw = config.QP_FIREBASE_SERVICE_ACCOUNT_JSON;
  return isSet(raw) ? parseServiceAccount(raw!, config.GCLOUD_PROJECT) : undefined;
}

/**
 * Why a variable failed, as a category. Never the input and never the expected shape beyond the category, so a
 * rejected secret cannot reach a log through it.
 */
export type ConfigReason = 'missing' | 'blank' | 'wrong_format' | 'whitespace' | 'not_https' | 'not_origin' | 'not_rediss' | 'out_of_range'
  | 'invalid_json' | 'project_mismatch' | 'mismatch' | 'not_allowed' | 'wildcard' | 'empty_entry' | 'too_many' | 'duplicate' | 'loopback_in_production';
export interface ConfigIssue { readonly name: string; readonly reason: ConfigReason }
/** Thrown by loadConfig. The message and `issues` hold variable NAMES and reason codes only, never a value. No `cause`. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(message: string, issues: readonly ConfigIssue[]) {
    super(message);
    this.name = 'ConfigError';
    this.issues = Object.freeze(issues.map(({ name, reason }) => Object.freeze({ name, reason })));
  }
}
interface Problem extends ConfigIssue { readonly message: string }

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
  // Strict digit regexes, not z.coerce: '', 'true', ' 3' and '1e3' must not turn into numbers. Range checks live in loadConfig.
  QP_REDIS_CONNECT_TIMEOUT_MS: z.string().regex(/^\d{1,5}$/).default(String(REDIS_CONNECT_TIMEOUT_DEFAULT_MS)).transform(Number),
  // Number of trusted proxy hops, socket = hop 0 (Render: 3). 0 trusts no proxy header. See apps/api/src/proxy.ts.
  TRUST_PROXY_HOPS: z.string().regex(/^[0-5]$/).default('0').transform(Number),
  // Comma separated browser origins allowed by the API's CORS hook; empty means no cross-origin access. Checked in loadConfig.
  QP_CORS_ORIGINS: z.string().default('').transform((value) => value.trim() === '' ? [] : value.split(',').map((entry) => entry.trim())),
  // Service-account key JSON for hosts without an ambient Google identity (Render). Opt-in; validated in loadConfig.
  QP_FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),
  // A regex, not z.coerce: an empty string would coerce to 0 retries silently.
  QP_QSTASH_RETRIES: z.string().regex(/^[0-3]$/).default('2').transform(Number),
  QP_QSTASH_TIMEOUT: z.string().regex(QSTASH_DURATION).refine(withinTimeoutBounds).default('90s'),
  // Checked in loadConfig, not with z.url(): a failure there must not carry the raw value.
  // Blank counts as unset: a Render `sync: false` prompt left empty arrives as '', and it must not fail the boot.
  QSTASH_URL: z.string().default(QSTASH_DEFAULT_URL).transform((value) => value.trim() === '' ? QSTASH_DEFAULT_URL : value),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Why a CORS list is rejected, judged on the first offending entry; undefined when the list is fine. */
function corsProblem(origins: readonly string[], production: boolean): ConfigReason | undefined {
  if (origins.length > CORS_ORIGINS_MAX) return 'too_many';
  for (const origin of origins) {
    if (origin === '') return 'empty_entry';
    if (origin.includes('*')) return 'wildcard';
    if (!URL.canParse(origin)) return 'wrong_format';
    const url = new URL(origin);
    if (url.origin !== origin) return 'not_origin';
    if (url.protocol === 'https:' && production && isLoopbackHost(url.hostname)) return 'loopback_in_production';
    if (!isCorsOrigin(origin, production)) return 'not_https';
  }
  return production && new Set(origins).size !== origins.length ? 'duplicate' : undefined;
}

/** Zod issue -> reason. Looks at the presence and shape of the input only; never copies the input or the zod message. */
function schemaReason(code: string, raw: string | undefined): ConfigReason {
  if (raw === undefined) return 'missing';
  if (raw.trim() === '') return 'blank';
  if (raw !== raw.trim()) return 'whitespace';
  return code === 'too_small' || code === 'too_big' ? 'out_of_range' : 'wrong_format';
}

/** The distinct messages of the problems, then every variable name with its reason. Never a value. */
function describe(problems: readonly Problem[]): string {
  const messages = [...new Set(problems.map((problem) => problem.message))].join('; ');
  return `${messages} [${problems.map((problem) => `${problem.name} ${problem.reason}`).join(', ')}]`;
}

/** Throws a ConfigError that names every failing variable (see ConfigIssue); the API and the worker share this loader. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // A refine that throws would carry the raw input (possibly a credential URL) in the error; never forward it.
  let parsed: ReturnType<typeof ConfigSchema.safeParse>;
  try { parsed = ConfigSchema.safeParse(env); } catch { throw new ConfigError('Invalid API configuration', []); }
  if (!parsed.success) {
    const known = Object.keys(ConfigSchema.shape);
    const schemaProblems: Problem[] = [];
    for (const issue of parsed.error.issues) {
      const name = issue.path[0];
      if (typeof name !== 'string' || !known.includes(name) || schemaProblems.some((problem) => problem.name === name)) continue;
      schemaProblems.push({ name, reason: schemaReason(issue.code, env[name]), message: 'Invalid API configuration' });
    }
    throw new ConfigError(schemaProblems.length ? describe(schemaProblems) : 'Invalid API configuration', schemaProblems);
  }
  const config = parsed.data;
  const problems: Problem[] = [];
  const fail = (name: string, reason: ConfigReason, message: string) => { problems.push({ name, reason, message }); };
  const production = config.QP_ENV === 'production';
  config.QP_QUEUE_ADAPTER ??= production ? 'cloud' : 'local';
  const adapter = config.QP_QUEUE_ADAPTER;
  const workerUrl = URL.canParse(config.QP_WORKER_URL) ? new URL(config.QP_WORKER_URL) : undefined;
  if (!workerUrl) fail('QP_WORKER_URL', 'wrong_format', 'Invalid API configuration');
  else if (workerUrl.origin !== config.QP_WORKER_URL) {
    fail('QP_WORKER_URL', config.QP_WORKER_URL !== config.QP_WORKER_URL.trim() ? 'whitespace' : 'not_origin', 'Worker URL must be an origin');
  }
  if (!isHttpsOrigin(config.QSTASH_URL)) {
    const url = URL.canParse(config.QSTASH_URL) ? new URL(config.QSTASH_URL) : undefined;
    const reason = config.QSTASH_URL !== config.QSTASH_URL.trim() ? 'whitespace' : !url ? 'wrong_format' : url.protocol !== 'https:' ? 'not_https' : 'not_origin';
    fail('QSTASH_URL', reason, 'QSTASH_URL must be an https origin');
  }
  // Constant messages: a rejected list is never echoed, because it may be a pasted secret or a typo of one.
  if (config.QP_REDIS_CONNECT_TIMEOUT_MS < REDIS_CONNECT_TIMEOUT_MIN_MS || config.QP_REDIS_CONNECT_TIMEOUT_MS > REDIS_CONNECT_TIMEOUT_MAX_MS) {
    fail('QP_REDIS_CONNECT_TIMEOUT_MS', 'out_of_range', 'QP_REDIS_CONNECT_TIMEOUT_MS is out of range');
  }
  const corsReason = corsProblem(config.QP_CORS_ORIGINS, production);
  if (corsReason) {
    fail('QP_CORS_ORIGINS', corsReason, 'QP_CORS_ORIGINS must be exact https origins (http://localhost and http://127.0.0.1 only outside production)');
  }
  const emulatorCulprits = [env.FIRESTORE_EMULATOR_HOST ? 'FIRESTORE_EMULATOR_HOST' : '', env.FIREBASE_AUTH_EMULATOR_HOST ? 'FIREBASE_AUTH_EMULATOR_HOST' : '',
    config.GCLOUD_PROJECT.startsWith('demo-') ? 'GCLOUD_PROJECT' : ''].filter(Boolean);
  if (isSet(config.QP_FIREBASE_SERVICE_ACCOUNT_JSON)) {
    if (emulatorCulprits.length > 0) {
      const message = 'QP_FIREBASE_SERVICE_ACCOUNT_JSON is not allowed with an emulator or a demo project';
      for (const name of [...emulatorCulprits, 'QP_FIREBASE_SERVICE_ACCOUNT_JSON']) fail(name, 'not_allowed', message);
    } else {
      // A key for another project is reported on the key (the value to replace), never with either project id.
      const reason = serviceAccountProblem(config.QP_FIREBASE_SERVICE_ACCOUNT_JSON!, config.GCLOUD_PROJECT);
      if (reason) fail('QP_FIREBASE_SERVICE_ACCOUNT_JSON', reason, 'QP_FIREBASE_SERVICE_ACCOUNT_JSON is invalid');
    }
  }
  // Render sets RENDER and has no ambient Google identity: without a key every Firestore call would fail after boot.
  // The Cloud Run path (RENDER unset) keeps its metadata identity. Constant message, no value.
  if (production && isSet(env.RENDER) && !isSet(config.QP_FIREBASE_SERVICE_ACCOUNT_JSON)) {
    fail('QP_FIREBASE_SERVICE_ACCOUNT_JSON', 'missing', 'QP_FIREBASE_SERVICE_ACCOUNT_JSON is required on this host');
  }
  if (adapter === 'cloud') {
    const message = 'Cloud queue requires HTTPS worker origin, matching audience and invoker service account';
    if (!config.QP_TASKS_INVOKER_SA) fail('QP_TASKS_INVOKER_SA', 'missing', message);
    if (!config.QP_TASKS_OIDC_AUDIENCE) fail('QP_TASKS_OIDC_AUDIENCE', 'missing', message);
    else if (config.QP_TASKS_OIDC_AUDIENCE !== config.QP_WORKER_URL) fail('QP_TASKS_OIDC_AUDIENCE', 'mismatch', message);
    if (workerUrl && workerUrl.protocol !== 'https:') fail('QP_WORKER_URL', 'not_https', message);
  }
  if (adapter === 'qstash') {
    const missing = QSTASH_VARS.filter((key) => !isSet(config[key]));
    for (const key of missing) fail(key, 'missing', `QStash queue requires ${missing.join(', ')}`);
    if (workerUrl && workerUrl.protocol !== 'https:' && production) fail('QP_WORKER_URL', 'not_https', 'QStash queue requires an HTTPS worker origin in production');
  }
  // The HMAC uses the key as given, so a stray newline or space from a pasted secret must fail loudly. Names only, never a value.
  // Only under qstash, where the keys are used (blank foreign values under another backend stay ignored, see the mixed-config tests).
  for (const key of ['QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY'] as const) {
    const value = config[key];
    if (adapter === 'qstash' && value !== undefined && value !== value.trim()) fail(key, 'whitespace', `${key} must not have leading or trailing whitespace`);
  }
  // The auth mode follows the queue backend: qstash <-> qstash, cloud/local <-> oidc (or local, checked below).
  if (!isSet(env.QP_WORKER_AUTH_MODE) && adapter === 'qstash') config.QP_WORKER_AUTH_MODE = 'qstash';
  if (config.QP_WORKER_AUTH_MODE === 'local' && (production || adapter !== 'local'
      || !/^(localhost|127\.0\.0\.1):\d+$/.test(env.FIRESTORE_EMULATOR_HOST ?? '')
      || !config.GCLOUD_PROJECT.startsWith('demo-'))) {
    fail('QP_WORKER_AUTH_MODE', 'not_allowed', 'Local worker auth requires a local emulator and demo project');
  }
  // Constant message: no value, so a mistyped secret cannot end up in it. Local mode was already settled above.
  if (config.QP_WORKER_AUTH_MODE !== 'local' && (config.QP_WORKER_AUTH_MODE === 'qstash') !== (adapter === 'qstash')) {
    fail('QP_WORKER_AUTH_MODE', 'mismatch', 'Worker auth mode does not match the queue backend');
  }
  if (production) {
    const message = 'Unsafe production configuration';
    if (adapter === 'local') fail('QP_QUEUE_ADAPTER', 'not_allowed', message);
    if (config.QP_WORKER_AUTH_MODE === 'local') fail('QP_WORKER_AUTH_MODE', 'not_allowed', message);
    if (config.QP_QUOTA_FAILURE_MODE === 'open') fail('QP_QUOTA_FAILURE_MODE', 'not_allowed', message);
    // The suffix of a fault variable comes from the environment: name it only when it is well formed.
    for (const key of Object.keys(env).filter((name) => name.startsWith('QP_FAULT_'))) fail(/^QP_FAULT_[A-Z0-9_]{1,60}$/.test(key) ? key : 'QP_FAULT_*', 'not_allowed', message);
    if (new URL(config.REDIS_URL).protocol !== 'rediss:') fail('REDIS_URL', 'not_rediss', 'Production requires a TLS Redis URL (rediss:)');
    const foreign: readonly string[] = adapter === 'qstash' ? CLOUD_TASKS_VARS : [...QSTASH_VARS, ...QSTASH_OPTIONAL_VARS];
    for (const key of foreign.filter((name) => isSet(env[name]))) fail(key, 'not_allowed', 'Ambiguous production configuration: queue backend settings are mixed');
    for (const name of emulatorCulprits) fail(name, 'not_allowed', 'Production requires a real project and no emulator overrides');
  }
  if (problems.length > 0) {
    const unique = problems.filter((problem, index) => problems.findIndex((other) => other.name === problem.name && other.reason === problem.reason) === index);
    throw new ConfigError(describe(unique), unique);
  }
  return config;
}

/**
 * Startup warnings for settings that are valid but probably not what the operator meant. Pure; the API logs them once at boot.
 * An empty QP_CORS_ORIGINS under qstash (the free profile: Hosting and the API are different origins) leaves the API
 * unusable from the browser without any error anywhere.
 */
export function configWarnings(config: Pick<Config, 'QP_ENV' | 'QP_QUEUE_ADAPTER' | 'QP_CORS_ORIGINS'>): string[] {
  const warnings: string[] = [];
  if (config.QP_ENV === 'production' && config.QP_QUEUE_ADAPTER === 'qstash' && config.QP_CORS_ORIGINS.length === 0) {
    warnings.push('QP_CORS_ORIGINS is empty: a browser on another origin (Firebase Hosting) cannot call this API. Set it to the exact Hosting origin(s).');
  }
  return warnings;
}

/** Config safe to log or dump: credentials are replaced, everything else is unchanged. */
export function redactConfig(config: Config): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...config };
  for (const key of SECRET_CONFIG_KEYS) if (copy[key] !== undefined) copy[key] = '[REDACTED]';
  return copy;
}
