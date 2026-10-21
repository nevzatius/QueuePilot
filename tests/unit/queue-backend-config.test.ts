import util from 'node:util';
import { describe, expect, it } from 'vitest';
import { createDispatchQueue, createLogger, loadConfig, LocalDispatchQueue, parseGoDurationMs, redactConfig } from '@queuepilot/core';

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

  it.each(['60s', '1m30s', '15m', '900s', '1m', '14m59s'])('accepts timeout %s', (value) => {
    expect(loadConfig({ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: value }).QP_QSTASH_TIMEOUT).toBe(value);
  });

  it.each(['59s', '59999ms', '16m', '1h30m', '2h', '1ms', '1ns', '99999999999999h'])('rejects timeout outside 60s..15m: %s', (value) => {
    expect(() => loadConfig({ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: value })).toThrow(/Invalid API configuration/);
  });

  it('1h30m is 90 minutes, above the 15 minute ceiling, and must not be read as 90 seconds', () => {
    expect(parseGoDurationMs('1h30m')).toBe(90 * 60_000);
    expect(() => loadConfig({ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: '1h30m' })).toThrow();
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

describe('F1 regression: malformed URLs never leak a secret through the thrown error', () => {
  const PASS = 'FAKE-leak-pass-5a7c13';
  const MALFORMED: Array<[string, Record<string, string>]> = [
    ['REDIS_URL missing a colon', { ...PROD_QSTASH, REDIS_URL: `rediss//default:${PASS}@host.invalid:6379` }],
    ['REDIS_URL with a bad port', { ...PROD_QSTASH, REDIS_URL: `rediss://default:${PASS}@host.invalid:99999999` }],
    ['REDIS_URL with a bad host', { ...PROD_QSTASH, REDIS_URL: `rediss://default:${PASS}@ho st.invalid:6379` }],
    ['worker URL missing a colon', { ...PROD_QSTASH, QP_WORKER_URL: `https//user:${PASS}@worker.invalid` }],
    ['worker URL with a bad port', { ...PROD_QSTASH, QP_WORKER_URL: `https://user:${PASS}@worker.invalid:99999999` }],
  ];

  it.each(MALFORMED)('%s', (_label, env) => {
    let thrown: unknown;
    try { loadConfig(env); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    const surfaces = [util.inspect(error, { depth: null, showHidden: true }), error.message, error.stack ?? '',
      util.inspect((error as { cause?: unknown }).cause, { depth: null, showHidden: true }),
      ...Object.keys(error).map((key) => util.inspect((error as unknown as Record<string, unknown>)[key], { depth: null, showHidden: true }))];
    for (const surface of surfaces) expect(surface).not.toContain(PASS);
    expect('cause' in error).toBe(false);
  });
});

describe('rediss in production', () => {
  it('rejects redis:// and accepts rediss://', () => {
    expect(() => loadConfig({ ...PROD_QSTASH, REDIS_URL: 'redis://default:pw@redis.invalid:6379' })).toThrow(/rediss/);
    expect(() => loadConfig({ ...PROD_CLOUD, REDIS_URL: 'redis://default:pw@redis.invalid:6379' })).toThrow(/rediss/);
    expect(() => loadConfig({ ...PROD_QSTASH, REDIS_URL: 'rediss://default:pw@redis.invalid:6379' })).not.toThrow();
  });
  it('still allows redis:// outside production', () => {
    expect(() => loadConfig({ REDIS_URL: 'redis://127.0.0.1:6379' })).not.toThrow();
  });
});

describe('mixed-config gaps', () => {
  it.each([
    ['QP_REGION', { QP_REGION: 'europe-west1' }],
    ['QP_SCHEDULER_SA', { QP_SCHEDULER_SA: 'sched@qp-test-project.iam.gserviceaccount.com' }],
  ])('qstash with %s is rejected', (_name, extra) => {
    expect(() => loadConfig({ ...PROD_QSTASH, ...extra })).toThrow(/Ambiguous/);
  });

  it.each([
    ['QSTASH_CURRENT_SIGNING_KEY', { QSTASH_CURRENT_SIGNING_KEY: FAKE.current }],
    ['QSTASH_NEXT_SIGNING_KEY', { QSTASH_NEXT_SIGNING_KEY: FAKE.next }],
    ['QP_QSTASH_RETRIES', { QP_QSTASH_RETRIES: '2' }],
  ])('cloud with %s is rejected', (_name, extra) => {
    expect(() => loadConfig({ ...PROD_CLOUD, ...extra })).toThrow(/Ambiguous/);
  });

  it('current behavior: blank foreign QSTASH_* values under cloud are ignored (isSet treats blank as unset)', () => {
    expect(() => loadConfig({ ...PROD_CLOUD, QSTASH_TOKEN: '', QSTASH_CURRENT_SIGNING_KEY: '  ', QSTASH_NEXT_SIGNING_KEY: '' })).not.toThrow();
  });

  it('current behavior: blank foreign QP_QSTASH_* values under cloud are rejected by the schema, not by the mixed-config check', () => {
    expect(() => loadConfig({ ...PROD_CLOUD, QP_QSTASH_RETRIES: '' })).toThrow(/Invalid API configuration/);
    expect(() => loadConfig({ ...PROD_CLOUD, QP_QSTASH_TIMEOUT: '' })).toThrow(/Invalid API configuration/);
  });

  it.each([['qstash', PROD_QSTASH], ['cloud', PROD_CLOUD]])('ftp: worker URL is rejected in production (%s)', (_name, env) => {
    expect(() => loadConfig({ ...env, QP_WORKER_URL: 'ftp://qp-worker.example.test', QP_TASKS_OIDC_AUDIENCE: 'ftp://qp-worker.example.test' })).toThrow();
  });

  it('validation errors carry no cause', () => {
    for (const env of [{ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: '30s' }, { ...PROD_QSTASH, QP_TASKS_QUEUE: 'x' }, without(PROD_QSTASH, 'QSTASH_TOKEN')]) {
      try { loadConfig(env); expect.unreachable(); } catch (error) { expect('cause' in (error as Error)).toBe(false); }
    }
  });
});
