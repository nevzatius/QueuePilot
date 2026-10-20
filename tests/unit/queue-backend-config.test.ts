import { describe, expect, it } from 'vitest';
import { createDispatchQueue, createLogger, loadConfig, LocalDispatchQueue, redactConfig } from '@queuepilot/core';

// Recognisable fakes; the assertions below prove none of them reaches any output.
const FAKE = { token: 'FAKE-qstash-token-7f3a91', current: 'FAKE-current-key-4c2d80', next: 'FAKE-next-key-9be615',
  redis: 'rediss://default:FAKE-redis-pass-1d84e7@redis.invalid:6380' };
const SECRETS = [FAKE.token, FAKE.current, FAKE.next, FAKE.redis, 'FAKE-redis-pass-1d84e7'];
const WORKER = 'https://qp-worker.example.test';

const QSTASH = { QSTASH_TOKEN: FAKE.token, QSTASH_CURRENT_SIGNING_KEY: FAKE.current, QSTASH_NEXT_SIGNING_KEY: FAKE.next };
const PROD_BASE = { QP_ENV: 'production', GCLOUD_PROJECT: 'qp-test-project', QP_WORKER_URL: WORKER, REDIS_URL: FAKE.redis };
const PROD_QSTASH: Record<string, string> = { ...PROD_BASE, QP_QUEUE_ADAPTER: 'qstash', ...QSTASH };
const PROD_CLOUD: Record<string, string> = { ...PROD_BASE, QP_QUEUE_ADAPTER: 'cloud', QP_TASKS_OIDC_AUDIENCE: WORKER,
  QP_TASKS_INVOKER_SA: 'qp-tasks-invoker-sa@qp-test-project.iam.gserviceaccount.com' };
const log = createLogger({ write: () => {} });
const clock = { now: () => new Date(0) } as never;
const without = (env: Record<string, string>, key: string) => Object.fromEntries(Object.entries(env).filter(([name]) => name !== key));

describe('queue backend selection', () => {
  it.each([
    ['development default is local', {}, 'local'],
    ['explicit local', { QP_QUEUE_ADAPTER: 'local' }, 'local'],
    ['production default is cloud', PROD_CLOUD, 'cloud'],
    ['qstash outside production', { QP_QUEUE_ADAPTER: 'qstash', ...QSTASH }, 'qstash'],
    ['qstash in production', PROD_QSTASH, 'qstash'],
  ])('%s', (_label, env, adapter) => {
    const input = adapter === 'cloud' ? without(env, 'QP_QUEUE_ADAPTER') : env;
    expect(loadConfig({ ...input }).QP_QUEUE_ADAPTER).toBe(adapter);
  });

  it('applies QStash defaults: 2 retries, 90s timeout', () => {
    expect(loadConfig(PROD_QSTASH)).toMatchObject({ QP_QSTASH_RETRIES: 2, QP_QSTASH_TIMEOUT: '90s' });
  });

  it.each([['0', 0], ['2', 2], ['3', 3]])('accepts retries %s', (value, parsed) => {
    expect(loadConfig({ ...PROD_QSTASH, QP_QSTASH_RETRIES: value }).QP_QSTASH_RETRIES).toBe(parsed);
  });

  it.each(['4', '-1', '', '1.5', 'two'])('rejects retries %j', (value) => {
    expect(() => loadConfig({ ...PROD_QSTASH, QP_QSTASH_RETRIES: value })).toThrow();
  });

  it.each(['60s', '1m30s', '500ms', '1.5s', '2h'])('accepts timeout %s', (value) => {
    expect(loadConfig({ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: value }).QP_QSTASH_TIMEOUT).toBe(value);
  });

  it.each(['60', '1.5', '60 s', 's', '', '0s', '-5s', '10d'])('rejects timeout without a valid unit: %j', (value) => {
    expect(() => loadConfig({ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: value })).toThrow();
  });

  it('selecting qstash fails fast in the factory and names B9-2, with no fallback', () => {
    expect(() => createDispatchQueue(loadConfig(PROD_QSTASH), clock, log)).toThrow(/B9-2/);
    expect(() => createDispatchQueue(loadConfig({ QP_QUEUE_ADAPTER: 'qstash', ...QSTASH }), clock, log)).toThrow(/B9-2/);
  });

  it('the local backend still builds the local queue', () => {
    expect(createDispatchQueue(loadConfig({}), clock, log)).toBeInstanceOf(LocalDispatchQueue);
  });
});

describe('production guard', () => {
  const rejections: Array<[string, Record<string, string>, RegExp]> = [
    ['local queue', { ...PROD_QSTASH, QP_QUEUE_ADAPTER: 'local' }, /Unsafe production/],
    ['missing token', without(PROD_QSTASH, 'QSTASH_TOKEN'), /QSTASH_TOKEN/],
    ['empty token', { ...PROD_QSTASH, QSTASH_TOKEN: '' }, /QSTASH_TOKEN/],
    ['blank current key', { ...PROD_QSTASH, QSTASH_CURRENT_SIGNING_KEY: '   ' }, /QSTASH_CURRENT_SIGNING_KEY/],
    ['missing next key', without(PROD_QSTASH, 'QSTASH_NEXT_SIGNING_KEY'), /QSTASH_NEXT_SIGNING_KEY/],
    ['http worker URL', { ...PROD_QSTASH, QP_WORKER_URL: 'http://qp-worker.example.test' }, /HTTPS/],
    ['worker URL with a path', { ...PROD_QSTASH, QP_WORKER_URL: `${WORKER}/internal` }, /origin/],
    ['timeout without unit', { ...PROD_QSTASH, QP_QSTASH_TIMEOUT: '60' }, /Invalid API configuration/],
    ['retries above 3', { ...PROD_QSTASH, QP_QSTASH_RETRIES: '4' }, /Invalid API configuration/],
    ['qstash with Cloud Tasks invoker SA', { ...PROD_QSTASH, QP_TASKS_INVOKER_SA: PROD_CLOUD.QP_TASKS_INVOKER_SA! }, /Ambiguous/],
    ['qstash with OIDC audience', { ...PROD_QSTASH, QP_TASKS_OIDC_AUDIENCE: WORKER }, /Ambiguous/],
    ['qstash with explicit queue name', { ...PROD_QSTASH, QP_TASKS_QUEUE: 'qp-process' }, /Ambiguous/],
    ['cloud with a QStash token', { ...PROD_CLOUD, QSTASH_TOKEN: FAKE.token }, /Ambiguous/],
    ['cloud with a QStash timeout', { ...PROD_CLOUD, QP_QSTASH_TIMEOUT: '60s' }, /Ambiguous/],
    ['qstash with quota fail-open', { ...PROD_QSTASH, QP_QUOTA_FAILURE_MODE: 'open' }, /Unsafe production/],
    ['qstash with fault flag', { ...PROD_QSTASH, QP_FAULT_CREATE: 'fail' }, /Unsafe production/],
    ['qstash with emulator override', { ...PROD_QSTASH, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, /no emulator/],
    ['qstash with local worker auth', { ...PROD_QSTASH, QP_WORKER_AUTH_MODE: 'local' }, /Local worker auth/],
  ];
  it.each(rejections)('rejects %s', (_label, env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('keeps accepting the pure Cloud Tasks and pure QStash production profiles', () => {
    expect(() => loadConfig(PROD_CLOUD)).not.toThrow();
    expect(() => loadConfig(PROD_QSTASH)).not.toThrow();
  });

  it('rejects incomplete qstash outside production too', () => {
    expect(() => loadConfig({ QP_QUEUE_ADAPTER: 'qstash' })).toThrow(/QSTASH_TOKEN/);
  });
});

describe('secrets hygiene', () => {
  const rejected: Array<Record<string, string>> = [
    { ...PROD_QSTASH, QP_QSTASH_TIMEOUT: '60' },
    { ...PROD_QSTASH, QP_QSTASH_RETRIES: '9' },
    { ...PROD_QSTASH, QP_WORKER_URL: 'http://qp-worker.example.test' },
    { ...PROD_QSTASH, QP_TASKS_INVOKER_SA: PROD_CLOUD.QP_TASKS_INVOKER_SA! },
    { ...PROD_QSTASH, QSTASH_NEXT_SIGNING_KEY: '' },
    { ...PROD_QSTASH, REDIS_URL: `not a url ${FAKE.token}` },
    { ...PROD_CLOUD, QSTASH_TOKEN: FAKE.token },
    { ...PROD_QSTASH, QP_QUEUE_ADAPTER: 'local' },
  ];
  const expectNoSecret = (text: string) => { for (const secret of SECRETS) expect(text).not.toContain(secret); };

  it.each(rejected.map((env, index) => [index, env] as const))('validation error %i carries no secret', (_index, env) => {
    let message = '';
    try { loadConfig(env); } catch (error) { message = error instanceof Error ? `${error.message}${error.stack ?? ''}` : String(error); }
    expect(message).not.toBe('');
    expectNoSecret(message);
  });

  it('factory error carries no secret', () => {
    let message = '';
    try { createDispatchQueue(loadConfig(PROD_QSTASH), clock, log); } catch (error) { message = (error as Error).message; }
    expect(message).not.toBe('');
    expectNoSecret(message);
  });

  it('redactConfig and the logger never serialise a credential', () => {
    const config = loadConfig(PROD_QSTASH);
    expect(config.QSTASH_TOKEN).toBe(FAKE.token); // the real value stays usable by adapters
    const dump = redactConfig(config);
    expectNoSecret(JSON.stringify(dump));
    expect(dump).toMatchObject({ QSTASH_TOKEN: '[REDACTED]', REDIS_URL: '[REDACTED]', QP_QSTASH_TIMEOUT: '90s' });
    const lines: string[] = [];
    const logger = createLogger({ write: (line: string) => { lines.push(line); } });
    logger.info({ config }, 'nested config');
    logger.info({ ...config }, 'flat config');
    expect(lines).toHaveLength(2);
    expectNoSecret(lines.join('\n'));
  });
});
