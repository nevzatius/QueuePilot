import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { configuredServiceAccount, createLogger, loadConfig, parseServiceAccount, redactConfig } from '@queuepilot/core';

// A throwaway key generated at test time: no key material is stored in the repository.
const PROJECT = 'qp-test-project';
const EMAIL = `firebase-adminsdk-fbsvc@${PROJECT}.iam.gserviceaccount.com`;
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keyJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  type: 'service_account', project_id: PROJECT, private_key_id: 'FAKE-key-id-5a1c', private_key: privateKey, client_email: EMAIL, client_id: '1', ...overrides });
const KEY_BODY = privateKey.split('\n')[1]!.slice(0, 24); // a recognisable slice of the PEM body
const SENTINELS = [KEY_BODY, 'FAKE-key-id-5a1c', privateKey.replaceAll('\n', '\n')];

const PROD = {
  QP_ENV: 'production', GCLOUD_PROJECT: PROJECT, QP_WORKER_URL: 'https://qp-worker.example.test', REDIS_URL: 'rediss://default:FAKE@redis.invalid:6380',
  QP_QUEUE_ADAPTER: 'qstash', QSTASH_TOKEN: 'FAKE-t', QSTASH_CURRENT_SIGNING_KEY: 'FAKE-c', QSTASH_NEXT_SIGNING_KEY: 'FAKE-n',
};
const expectNoKey = (text: string) => { for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel); };
const failure = (env: Record<string, string>) => {
  try { loadConfig(env); } catch (error) { return error instanceof Error ? `${error.message}${error.stack ?? ''}${String(error.cause ?? '')}` : String(error); }
  return '';
};

describe('QP_FIREBASE_SERVICE_ACCOUNT_JSON', () => {
  it('is optional: without it no credential is configured and the SDK falls back to ambient credentials', () => {
    expect(configuredServiceAccount(loadConfig(PROD))).toBeUndefined();
    expect(configuredServiceAccount(loadConfig({ ...PROD, QP_FIREBASE_SERVICE_ACCOUNT_JSON: '   ' }))).toBeUndefined();
  });

  it('accepts a key for the configured project and keeps only the three fields the SDK needs', () => {
    const account = configuredServiceAccount(loadConfig({ ...PROD, QP_FIREBASE_SERVICE_ACCOUNT_JSON: keyJson() }));
    expect(account).toEqual({ projectId: PROJECT, clientEmail: EMAIL, privateKey });
  });

  it.each([
    ['not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['null', 'null'],
    ['another type', keyJson({ type: 'authorized_user' })],
    ['another project', keyJson({ project_id: 'other-project' })],
    ['a non service-account email', keyJson({ client_email: 'someone@example.test' })],
    ['a missing email', keyJson({ client_email: undefined })],
    ['a private key that is not PEM', keyJson({ private_key: 'FAKE-not-a-pem' })],
    ['a truncated PEM', keyJson({ private_key: privateKey.slice(0, 120) })],
    ['a numeric private key', keyJson({ private_key: 5 })],
  ])('rejects %s with a constant message that carries no part of the input', (_label, value) => {
    const message = failure({ ...PROD, QP_FIREBASE_SERVICE_ACCOUNT_JSON: value });
    expect(message).toContain('QP_FIREBASE_SERVICE_ACCOUNT_JSON is invalid');
    expectNoKey(message);
    expect(message).not.toContain(value.slice(0, 20));
  });

  it('echoes nothing of a JSON syntax error either (Node quotes a slice of the input)', () => {
    const message = failure({ ...PROD, QP_FIREBASE_SERVICE_ACCOUNT_JSON: `{"private_key": "${KEY_BODY}` });
    expect(message).toContain('invalid');
    expectNoKey(message);
  });

  it.each([
    ['a Firestore emulator', { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }],
    ['an Auth emulator', { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }],
  ])('is refused next to %s, even when the key itself is fine', (_label, extra) => {
    const message = failure({ ...PROD, ...extra, QP_ENV: 'development', QP_FIREBASE_SERVICE_ACCOUNT_JSON: keyJson() });
    expect(message).toContain('not allowed with an emulator or a demo project');
    expectNoKey(message);
  });

  it('is refused for a demo-* project', () => {
    const message = failure({ ...PROD, QP_ENV: 'development', GCLOUD_PROJECT: 'demo-queuepilot', QP_FIREBASE_SERVICE_ACCOUNT_JSON: keyJson({ project_id: 'demo-queuepilot' }) });
    expect(message).toContain('not allowed with an emulator or a demo project');
  });

  it('parseServiceAccount is exported for the one place that builds credentials, and fails the same way', () => {
    expect(() => parseServiceAccount('{}', PROJECT)).toThrow('QP_FIREBASE_SERVICE_ACCOUNT_JSON is invalid');
  });

  it('redactConfig and the logger never serialise the key, flat or nested', () => {
    const config = loadConfig({ ...PROD, QP_FIREBASE_SERVICE_ACCOUNT_JSON: keyJson() });
    expect(config.QP_FIREBASE_SERVICE_ACCOUNT_JSON).toBe(keyJson()); // adapters still get the real value
    const dump = redactConfig(config);
    expect(dump.QP_FIREBASE_SERVICE_ACCOUNT_JSON).toBe('[REDACTED]');
    expectNoKey(JSON.stringify(dump));
    const lines: string[] = [];
    const logger = createLogger({ write: (line: string) => { lines.push(line); } });
    logger.info({ config }, 'nested config');
    logger.info({ ...config }, 'flat config');
    expect(lines).toHaveLength(2);
    expectNoKey(lines.join('\n'));
  });
});
