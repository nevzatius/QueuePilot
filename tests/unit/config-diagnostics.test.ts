import { generateKeyPairSync } from 'node:crypto';
import util from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type ConfigIssue } from '@queuepilot/core';

// Every failing input below carries a recognisable FAKE marker. The assertions prove that the error names the variable and a
// reason code and that no marker reaches the message, the stack, the cause, the issues or the util.inspect output.
const PROJECT = 'qp-test-project';
const WORKER = 'https://qp-worker.example.test';
const QSTASH = { QSTASH_TOKEN: 'FAKE-qstash-token-7f3a91', QSTASH_CURRENT_SIGNING_KEY: 'FAKE-current-key-4c2d80', QSTASH_NEXT_SIGNING_KEY: 'FAKE-next-key-9be615' };
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const keyJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({ type: 'service_account', project_id: PROJECT,
  client_email: `fake-signer@${PROJECT}.iam.gserviceaccount.com`, private_key: privateKey, ...overrides });
const GOOD: Record<string, string> = { QP_ENV: 'production', GCLOUD_PROJECT: PROJECT, QP_QUEUE_ADAPTER: 'qstash', QP_WORKER_AUTH_MODE: 'qstash', QP_WORKER_URL: WORKER,
  QSTASH_URL: 'https://qstash-eu.example.test', REDIS_URL: 'rediss://default:FAKE-redis-pass-1d84e7@redis.example.test:6380', ...QSTASH };
const without = (env: Record<string, string>, ...keys: string[]) => Object.fromEntries(Object.entries(env).filter(([name]) => !keys.includes(name)));
const sorted = (issues: readonly ConfigIssue[]) => issues.map(({ name, reason }) => `${name} ${reason}`).sort();

function failure(env: Record<string, string>): ConfigError {
  try { loadConfig(env); } catch (error) { expect(error).toBeInstanceOf(ConfigError); return error as ConfigError; }
  throw new Error('expected loadConfig to throw');
}
/** Every rendering of the error that a log, a crash report or a debugger could print. */
function renderings(error: ConfigError): string {
  return [error.message, error.stack ?? '', String(error), util.inspect(error, { depth: null, showHidden: true }), JSON.stringify(error.issues),
    JSON.stringify(error, Object.getOwnPropertyNames(error)), String(error.cause)].join('\n');
}

describe('loadConfig names the failing variables', () => {
  it('accepts the good production qstash configuration', () => {
    expect(loadConfig({ ...GOOD }).QP_QUEUE_ADAPTER).toBe('qstash');
    expect(loadConfig({ ...GOOD, RENDER: 'true', QP_FIREBASE_SERVICE_ACCOUNT_JSON: keyJson() }).QP_QUEUE_ADAPTER).toBe('qstash');
  });

  it.each<[string, Record<string, string>, string[]]>([
    // schema failures
    ['worker URL that is not a URL', { QP_WORKER_URL: 'FAKE-not-a-url-31' }, ['QP_WORKER_URL wrong_format']],
    ['unknown adapter', { QP_QUEUE_ADAPTER: 'FAKE-adapter-31' }, ['QP_QUEUE_ADAPTER wrong_format']],
    ['unparsable timeout', { QP_QSTASH_TIMEOUT: 'FAKE-timeout-77' }, ['QP_QSTASH_TIMEOUT wrong_format']],
    ['trust proxy hops that is not a digit', { TRUST_PROXY_HOPS: 'FAKE-hops-9' }, ['TRUST_PROXY_HOPS wrong_format']],
    ['redis URL that is not a URL', { REDIS_URL: 'FAKE-redis-not-a-url-88' }, ['REDIS_URL wrong_format']],
    ['blank redis URL', { REDIS_URL: '' }, ['REDIS_URL blank']],
    ['environment name with a leading space', { QP_ENV: ' production' }, ['QP_ENV whitespace']],
    ['two schema failures', { QP_WORKER_URL: 'FAKE-not-a-url-31', TRUST_PROXY_HOPS: 'FAKE-hops-9' }, ['QP_WORKER_URL wrong_format', 'TRUST_PROXY_HOPS wrong_format']],
    ['redis connect timeout out of range', { QP_REDIS_CONNECT_TIMEOUT_MS: '50' }, ['QP_REDIS_CONNECT_TIMEOUT_MS out_of_range']],
    // single-variable cross-field checks
    ['http worker URL', { QP_WORKER_URL: 'http://fake-worker-31.example.test' }, ['QP_WORKER_URL not_https']],
    ['worker URL with a path', { QP_WORKER_URL: `${WORKER}/FAKE-path-31` }, ['QP_WORKER_URL not_origin']],
    ['http qstash URL', { QSTASH_URL: 'http://fake-qstash-31.example.test' }, ['QSTASH_URL not_https']],
    ['qstash URL with a path', { QSTASH_URL: 'https://fake-qstash-31.example.test/FAKE-path' }, ['QSTASH_URL not_origin']],
    ['qstash URL that is not a URL', { QSTASH_URL: 'FAKE-qstash-url-31' }, ['QSTASH_URL wrong_format']],
    ['redis:// instead of rediss://', { REDIS_URL: 'redis://default:FAKE-redis-pass-1d84e7@redis.example.test:6379' }, ['REDIS_URL not_rediss']],
    ['trailing space in the current signing key', { QSTASH_CURRENT_SIGNING_KEY: `${QSTASH.QSTASH_CURRENT_SIGNING_KEY} ` }, ['QSTASH_CURRENT_SIGNING_KEY whitespace']],
    ['trailing newline in the next signing key', { QSTASH_NEXT_SIGNING_KEY: `${QSTASH.QSTASH_NEXT_SIGNING_KEY}\n` }, ['QSTASH_NEXT_SIGNING_KEY whitespace']],
    ['missing token', { QSTASH_TOKEN: '' }, ['QSTASH_TOKEN missing']],
    ['empty CORS entry', { QP_CORS_ORIGINS: 'https://a.example.test,,https://b.example.test' }, ['QP_CORS_ORIGINS empty_entry']],
    ['CORS wildcard', { QP_CORS_ORIGINS: 'https://*.example.test' }, ['QP_CORS_ORIGINS wildcard']],
    ['CORS http origin in production', { QP_CORS_ORIGINS: 'http://a.example.test' }, ['QP_CORS_ORIGINS not_https']],
    ['CORS origin with a path', { QP_CORS_ORIGINS: 'https://a.example.test/FAKE-path' }, ['QP_CORS_ORIGINS not_origin']],
    ['CORS loopback in production', { QP_CORS_ORIGINS: 'https://localhost:5173' }, ['QP_CORS_ORIGINS loopback_in_production']],
    ['CORS duplicate in production', { QP_CORS_ORIGINS: 'https://a.example.test,https://a.example.test' }, ['QP_CORS_ORIGINS duplicate']],
    ['CORS list too long', { QP_CORS_ORIGINS: Array.from({ length: 11 }, (_, i) => `https://a${i}.example.test`).join(',') }, ['QP_CORS_ORIGINS too_many']],
    ['service-account JSON that is not JSON', { RENDER: 'true', QP_FIREBASE_SERVICE_ACCOUNT_JSON: '{FAKE-not-json-4411' }, ['QP_FIREBASE_SERVICE_ACCOUNT_JSON invalid_json']],
    ['service-account key of another project', { RENDER: 'true', QP_FIREBASE_SERVICE_ACCOUNT_JSON: keyJson({ project_id: 'fake-other-project' }) }, ['QP_FIREBASE_SERVICE_ACCOUNT_JSON project_mismatch']],
    ['service-account key missing on Render', { RENDER: 'true' }, ['QP_FIREBASE_SERVICE_ACCOUNT_JSON missing']],
    ['worker auth mode oidc under qstash', { QP_WORKER_AUTH_MODE: 'oidc' }, ['QP_WORKER_AUTH_MODE mismatch']],
    ['quota failure mode open', { QP_QUOTA_FAILURE_MODE: 'open' }, ['QP_QUOTA_FAILURE_MODE not_allowed']],
    ['fault injection variable', { QP_FAULT_DROP: 'FAKE-1' }, ['QP_FAULT_DROP not_allowed']],
    ['malformed fault injection variable name', { QP_FAULT_lower: 'FAKE-1' }, ['QP_FAULT_* not_allowed']],
    ['Cloud Tasks setting mixed in', { QP_TASKS_QUEUE: 'FAKE-queue-31' }, ['QP_TASKS_QUEUE not_allowed']],
    ['emulator host in production', { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, ['FIRESTORE_EMULATOR_HOST not_allowed']],
    ['demo project in production', { GCLOUD_PROJECT: 'demo-queuepilot' }, ['GCLOUD_PROJECT not_allowed']],
    ['emulator host together with a service-account key', { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', QP_FIREBASE_SERVICE_ACCOUNT_JSON: keyJson() },
      ['FIRESTORE_EMULATOR_HOST not_allowed', 'QP_FIREBASE_SERVICE_ACCOUNT_JSON not_allowed']],
    // several at once: the doctor lists them all
    ['several cross-field failures', { QP_WORKER_URL: 'http://fake-worker-31.example.test', REDIS_URL: 'redis://default:FAKE-pw-31@redis.example.test:6379', QSTASH_URL: 'http://fake-qstash-31.example.test' },
      ['QP_WORKER_URL not_https', 'REDIS_URL not_rediss', 'QSTASH_URL not_https']],
  ])('%s', (_label, override, expected) => {
    const error = failure({ ...GOOD, ...override });
    expect(sorted(error.issues)).toEqual([...expected].sort());
    for (const line of expected) expect(error.message).toContain(line);
    // Hard-coded markers, so a mutation that echoes any input into the error fails here.
    const text = renderings(error);
    for (const fragment of ['FAKE-', 'example.test/', 'redis.example.test', 'fake-worker-31', 'fake-qstash-31', '-----BEGIN', 'iam.gserviceaccount.com', 'fake-other-project']) {
      expect(text).not.toContain(fragment);
    }
    expect(error.cause).toBeUndefined();
  });

  it('cloud queue: names the invoker, the audience and the worker URL', () => {
    const cloud = { QP_ENV: 'production', GCLOUD_PROJECT: PROJECT, QP_WORKER_URL: WORKER, REDIS_URL: GOOD.REDIS_URL! };
    expect(sorted(failure(cloud).issues)).toEqual(['QP_TASKS_INVOKER_SA missing', 'QP_TASKS_OIDC_AUDIENCE missing']);
    expect(sorted(failure({ ...cloud, QP_TASKS_INVOKER_SA: `fake@${PROJECT}.iam.gserviceaccount.com`, QP_TASKS_OIDC_AUDIENCE: 'https://other-audience.example.test' }).issues))
      .toEqual(['QP_TASKS_OIDC_AUDIENCE mismatch']);
  });

  it('keeps the existing named messages', () => {
    expect(() => loadConfig({ ...GOOD, QSTASH_URL: 'http://fake-qstash-31.example.test' })).toThrow(/^QSTASH_URL must be an https origin \[/);
    expect(() => loadConfig({ ...GOOD, QSTASH_CURRENT_SIGNING_KEY: 'x ' })).toThrow(/^QSTASH_CURRENT_SIGNING_KEY must not have leading or trailing whitespace \[/);
    expect(() => loadConfig({ ...GOOD, REDIS_URL: 'redis://h:1' })).toThrow(/^Production requires a TLS Redis URL \(rediss:\) \[REDIS_URL not_rediss\]$/);
    expect(() => loadConfig({ ...GOOD, RENDER: 'true' })).toThrow(/^QP_FIREBASE_SERVICE_ACCOUNT_JSON is required on this host \[/);
    expect(() => loadConfig({ ...GOOD, QP_WORKER_URL: 'FAKE-x' })).toThrow(/^Invalid API configuration \[QP_WORKER_URL wrong_format\]$/);
  });

  it('a worker URL with a trailing space is accepted: z.url() trims it, and the trimmed value is what the service uses', () => {
    expect(loadConfig({ ...GOOD, QP_WORKER_URL: `${WORKER} ` }).QP_WORKER_URL).toBe(WORKER);
  });

  it('a CORS list with a space after the comma is accepted: the loader trims entries', () => {
    expect(loadConfig({ ...GOOD, QP_CORS_ORIGINS: 'https://a.example.test, https://b.example.test' }).QP_CORS_ORIGINS).toEqual(['https://a.example.test', 'https://b.example.test']);
  });

  it('a blank QSTASH_URL is accepted (it means the default): Render prompts left empty must not fail the boot', () => {
    expect(loadConfig({ ...GOOD, QSTASH_URL: '' }).QSTASH_URL).toBe('https://qstash.upstash.io');
    expect(loadConfig({ ...without(GOOD, 'QSTASH_URL'), QSTASH_URL: '   ' }).QSTASH_URL).toBe('https://qstash.upstash.io');
  });

  it('a failure the schema cannot attribute to a variable still throws a ConfigError with the constant message', () => {
    const error = new ConfigError('Invalid API configuration', []);
    expect(error.issues).toEqual([]);
    expect(error.message).toBe('Invalid API configuration');
  });

  it('the issues are frozen plain data', () => {
    const error = failure({ ...GOOD, REDIS_URL: 'redis://h:1' });
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.keys(error.issues[0]!).sort()).toEqual(['name', 'reason']);
  });
});
