import util from 'node:util';
import { describe, expect, it } from 'vitest';
import { CloudTasksQueue, createDispatchQueue, createLogger, loadConfig, LocalDispatchQueue, parseGoDurationMs, QStashQueue, redactConfig } from '@queuepilot/core';

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

  it.each(['60s', '90s', '5m', '15m', '900s', '1m', '899s'])('accepts timeout %s', (value) => {
    expect(loadConfig({ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: value }).QP_QSTASH_TIMEOUT).toBe(value);
  });

  it.each(['59s', '16m', '901s', '2h', '1h', '0m', '99999999999999h'])('rejects timeout outside 60s..15m: %s', (value) => {
    expect(() => loadConfig({ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: value })).toThrow(/Invalid API configuration/);
  });

  it.each(['1m30s', '1h30m', '90000ms', '59999ms', '1.5s', '1.5m', '1ms', '1ns', '1us', '90S', ' 90s', '90s ', '+90s'])('rejects what QStash does not document, only <number><s|m|h> is accepted: %j', (value) => {
    expect(() => loadConfig({ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: value })).toThrow(/Invalid API configuration/);
  });

  it('parses the three documented units', () => {
    expect([parseGoDurationMs('90s'), parseGoDurationMs('5m'), parseGoDurationMs('1h')]).toEqual([90_000, 300_000, 3_600_000]);
  });

  it.each(['60', '1.5', '60 s', 's', '', '0s', '-5s', '10d'])('rejects timeout without a valid unit: %j', (value) => {
    expect(() => loadConfig({ ...PROD_QSTASH, QP_QSTASH_TIMEOUT: value })).toThrow();
  });

  it('selecting qstash builds the QStash adapter, never the local queue or Cloud Tasks', () => {
    for (const env of [PROD_QSTASH, { QP_QUEUE_ADAPTER: 'qstash', ...QSTASH }]) {
      const queue = createDispatchQueue(loadConfig(env), clock, log);
      expect(queue).toBeInstanceOf(QStashQueue);
      expect(queue).not.toBeInstanceOf(LocalDispatchQueue);
    }
  });

  it('selecting cloud still builds the Cloud Tasks adapter', () => {
    expect(createDispatchQueue(loadConfig(without(PROD_CLOUD, 'QP_QUEUE_ADAPTER')), clock, log)).toBeInstanceOf(CloudTasksQueue);
  });

  it('the factory passes the validated settings to the adapter: URL, retries and timeout reach the publish call', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return new Response('{"messageId":"msg_1"}', { status: 201 });
    }) as unknown as typeof fetch;
    try {
      const config = loadConfig({ ...PROD_QSTASH, QSTASH_URL: 'https://qstash-eu-central-1.upstash.io', QP_QSTASH_RETRIES: '3', QP_QSTASH_TIMEOUT: '2m' });
      await createDispatchQueue(config, clock, log).enqueue({ requestId: crypto.randomUUID(), tenantId: 'test-queue', seq: 1, correlationId: crypto.randomUUID() }, new AbortController().signal);
    } finally { globalThis.fetch = realFetch; }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://qstash-eu-central-1.upstash.io/v2/publish/${WORKER}/internal/tasks`);
    expect(calls[0]!.headers).toMatchObject({ 'Upstash-Retries': '3', 'Upstash-Timeout': '2m', Authorization: `Bearer ${FAKE.token}` });
  });

  it('a hand-built Config without a token still stops startup, with no secret in the error', () => {
    const config = { ...loadConfig(PROD_QSTASH), QSTASH_TOKEN: undefined };
    expect(() => createDispatchQueue(config, clock, log)).toThrow(/QSTASH_TOKEN/);
  });

  it('the local backend still builds the local queue', () => {
    expect(createDispatchQueue(loadConfig({}), clock, log)).toBeInstanceOf(LocalDispatchQueue);
  });
});

const MISMATCH = /^Worker auth mode does not match the queue backend \[QP_WORKER_AUTH_MODE mismatch\]$/;

describe('worker auth mode follows the queue backend', () => {
  it.each([
    ['production qstash, unset', PROD_QSTASH, 'qstash'],
    ['production qstash, explicit', { ...PROD_QSTASH, QP_WORKER_AUTH_MODE: 'qstash' }, 'qstash'],
    ['development qstash, unset', { QP_QUEUE_ADAPTER: 'qstash', ...QSTASH }, 'qstash'],
    ['production cloud, unset', PROD_CLOUD, 'oidc'],
    ['production cloud, explicit', { ...PROD_CLOUD, QP_WORKER_AUTH_MODE: 'oidc' }, 'oidc'],
    ['development local, unset', {}, 'oidc'],
  ])('%s', (_label, env, mode) => {
    expect(loadConfig(env).QP_WORKER_AUTH_MODE).toBe(mode);
  });

  it('qstash does not require or accept the OIDC settings', () => {
    const config = loadConfig(PROD_QSTASH);
    expect([config.QP_TASKS_OIDC_AUDIENCE, config.QP_TASKS_INVOKER_SA, config.QP_SCHEDULER_SA]).toEqual([undefined, undefined, undefined]);
    expect(() => loadConfig({ ...PROD_QSTASH, QP_SCHEDULER_SA: 'qp-scheduler-sa@qp-test-project.iam.gserviceaccount.com' })).toThrow(/Ambiguous/);
  });

  it.each([
    ['local adapter with qstash auth', { QP_WORKER_AUTH_MODE: 'qstash' }],
    ['qstash adapter with oidc auth, outside production', { QP_QUEUE_ADAPTER: 'qstash', ...QSTASH, QP_WORKER_AUTH_MODE: 'oidc' }],
  ])('rejects %s in every environment', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(MISMATCH);
  });

  it('the mismatch message is constant and carries no configured value', () => {
    for (const env of [{ ...PROD_QSTASH, QP_WORKER_AUTH_MODE: 'oidc' }, { ...PROD_CLOUD, QP_WORKER_AUTH_MODE: 'qstash', ...QSTASH }]) {
      let message = '';
      try { loadConfig(env); } catch (error) { message = util.inspect(error, { depth: 5 }); }
      expect(message).toContain('Worker auth mode does not match');
      for (const secret of SECRETS) expect(message).not.toContain(secret);
    }
  });
});

describe('signing keys are used untrimmed, so surrounding whitespace is rejected (PR #5 review F6)', () => {
  it.each([
    ['QSTASH_CURRENT_SIGNING_KEY', `${FAKE.current}
`, 'trailing newline'],
    ['QSTASH_CURRENT_SIGNING_KEY', ` ${FAKE.current}`, 'leading space'],
    ['QSTASH_NEXT_SIGNING_KEY', `${FAKE.next}
`, 'trailing CRLF'],
    ['QSTASH_NEXT_SIGNING_KEY', `	${FAKE.next}`, 'leading tab'],
    ['QSTASH_NEXT_SIGNING_KEY', `${FAKE.next} `, 'trailing space'],
  ])('%s with a %s is rejected, naming only the variable', (name, value) => {
    for (const env of [PROD_QSTASH, { QP_QUEUE_ADAPTER: 'qstash', ...QSTASH }]) {
      let message = '';
      try { loadConfig({ ...env, [name]: value }); } catch (error) { message = util.inspect(error, { depth: 5 }) + String(error); }
      expect(message).toContain(`${name} must not have leading or trailing whitespace`);
      for (const secret of SECRETS) expect(message).not.toContain(secret);
    }
  });
  it('clean keys still load', () => {
    expect(loadConfig(PROD_QSTASH).QSTASH_CURRENT_SIGNING_KEY).toBe(FAKE.current);
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
    ['qstash with oidc worker auth', { ...PROD_QSTASH, QP_WORKER_AUTH_MODE: 'oidc' }, MISMATCH],
    ['cloud with qstash worker auth', { ...PROD_CLOUD, QP_WORKER_AUTH_MODE: 'qstash' }, MISMATCH],
    ['cloud (default adapter) with qstash worker auth', { ...without(PROD_CLOUD, 'QP_QUEUE_ADAPTER'), QP_WORKER_AUTH_MODE: 'qstash' }, MISMATCH],
    ['cloud with local worker auth', { ...PROD_CLOUD, QP_WORKER_AUTH_MODE: 'local' }, /Local worker auth/],
    ['unknown worker auth mode', { ...PROD_QSTASH, QP_WORKER_AUTH_MODE: 'bearer' }, /Invalid API configuration/],
    ['empty worker auth mode', { ...PROD_QSTASH, QP_WORKER_AUTH_MODE: '' }, /Invalid API configuration/],
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
    try { createDispatchQueue({ ...loadConfig(PROD_QSTASH), QSTASH_TOKEN: undefined }, clock, log); } catch (error) { message = (error as Error).message; }
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

describe('QSTASH_URL', () => {
  it('defaults to the global QStash endpoint', () => {
    expect(loadConfig(PROD_QSTASH).QSTASH_URL).toBe('https://qstash.upstash.io');
  });
  it.each(['https://qstash-eu-central-1.upstash.io', 'https://qstash-us-east-1.upstash.io'])('accepts the regional origin %s', (url) => {
    expect(loadConfig({ ...PROD_QSTASH, QSTASH_URL: url }).QSTASH_URL).toBe(url);
    expect(loadConfig({ QP_QUEUE_ADAPTER: 'qstash', ...QSTASH, QSTASH_URL: url }).QSTASH_URL).toBe(url);
  });
  it.each([
    ['http', 'http://qstash.upstash.io'], ['a path', 'https://qstash.upstash.io/v2'], ['a trailing slash', 'https://qstash.upstash.io/'],
    ['a query', 'https://qstash.upstash.io?x=1'], ['credentials', 'https://user:FAKE-url-pass-3c9d21@qstash.upstash.io'],
    ['no scheme', 'qstash.upstash.io'], ['ftp', 'ftp://qstash.upstash.io'], ['padding', ' https://qstash.upstash.io'],
  ])('rejects %s without echoing the value', (_label, url) => {
    let message = '';
    try { loadConfig({ ...PROD_QSTASH, QSTASH_URL: url }); } catch (error) { message = `${(error as Error).message}${(error as Error).stack ?? ''}`; }
    expect(message).toMatch(/QSTASH_URL must be an https origin/);
    expect(message).not.toContain('FAKE-url-pass-3c9d21');
  });
  it.each(['', ' ', '\t'])('treats a blank value %j as the default (an empty Render prompt arrives as an empty string)', (blank) => {
    expect(loadConfig({ ...PROD_QSTASH, QSTASH_URL: blank }).QSTASH_URL).toBe('https://qstash.upstash.io');
    expect(loadConfig({ QP_QUEUE_ADAPTER: 'qstash', ...QSTASH, QSTASH_URL: blank }).QSTASH_URL).toBe('https://qstash.upstash.io');
    expect(loadConfig({ ...PROD_CLOUD, QSTASH_URL: blank }).QSTASH_URL).toBe('https://qstash.upstash.io'); // blank is not a mixed-backend setting
  });
  it('is validated outside production and for the other backends too', () => {
    expect(() => loadConfig({ QSTASH_URL: 'http://qstash.upstash.io' })).toThrow(/QSTASH_URL/);
    expect(() => loadConfig({ QP_QUEUE_ADAPTER: 'qstash', ...QSTASH, QSTASH_URL: 'http://localhost:9999' })).toThrow(/QSTASH_URL/);
  });
  it('is a QStash-only setting: Cloud Tasks production rejects it as mixed config', () => {
    expect(() => loadConfig({ ...PROD_CLOUD, QSTASH_URL: 'https://qstash.upstash.io' })).toThrow(/Ambiguous/);
  });
  it('is not a secret, so redactConfig keeps it readable', () => {
    expect(redactConfig(loadConfig(PROD_QSTASH))).toMatchObject({ QSTASH_URL: 'https://qstash.upstash.io' });
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
