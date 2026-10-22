/* global structuredClone, Headers */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, ScriptError, runCli } from './lib/ops.mjs';
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT, MAX_RETRIES, RECONCILE_PATH, TIMEOUT_MAX_MS, TIMEOUT_MIN_MS, isTimeout } from './lib/qstash.mjs';
import { parseSetupArgs, runSetup } from './qstash-setup.mjs';
import { parseShutdownArgs, runQStashShutdown } from './qstash-shutdown.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'FAKE-qstash-token-7f3a91c2';
const WORKER = 'https://qp-worker.example.test';
const DESTINATION = `${WORKER}${RECONCILE_PATH}`;
const OTHER = 'https://elsewhere.example.test/hook';
const ENV = { QP_WORKER_URL: WORKER, QSTASH_TOKEN: TOKEN };
const APPLY = ['--apply', '--approve-destination', DESTINATION];

const io = () => { const lines = []; return { lines, out: (m) => lines.push(m), err: (m) => lines.push(m) }; };
const jsonResponse = (status, body, headers = {}) => ({ status, headers: new Headers(headers), json: async () => body });

/**
 * A stateful QStash double. It stores what a create/upsert request carried and lists it back in the
 * documented shape, records every call, and can be told to fail or to echo the token in its bodies.
 */
function fakeQStash({ schedules = [], failWith, echoToken = false } = {}) {
  const state = { schedules: structuredClone(schedules), calls: [], next: 1 };
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    state.calls.push({ method, url, headers: init.headers });
    const echo = echoToken ? { error: `bad token ${TOKEN}`, authorization: init.headers.authorization } : {};
    if (failWith) {
      if (failWith.networkError) throw new Error(`connect failed for Bearer ${TOKEN}`);
      return jsonResponse(failWith.status, { ...echo, message: `denied ${TOKEN}` }, failWith.headers);
    }
    if (method === 'GET') return jsonResponse(200, state.schedules);
    if (method === 'POST') {
      const destination = url.slice(url.indexOf('/v2/schedules/') + '/v2/schedules/'.length);
      const h = init.headers;
      const id = h['upstash-schedule-id'] ?? `scd_${state.next++}`;
      const entry = { scheduleId: id, destination, cron: h['upstash-cron'], method: h['upstash-method'], retries: Number(h['upstash-retries']),
        header: { 'Upstash-Timeout': [h['upstash-timeout']] }, isPaused: false };
      const index = state.schedules.findIndex((s) => s.scheduleId === id);
      if (index >= 0) state.schedules[index] = entry; else state.schedules.push(entry);
      return jsonResponse(h['upstash-schedule-id'] ? 200 : 201, { scheduleId: id, ...echo });
    }
    if (method === 'DELETE') {
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const index = state.schedules.findIndex((s) => s.scheduleId === id);
      if (index < 0) return jsonResponse(404, { error: 'not found' });
      state.schedules.splice(index, 1);
      return jsonResponse(200, {});
    }
    throw new Error('unexpected method');
  };
  return Object.assign(state, { fetch: fetchImpl, writes: () => state.calls.filter((c) => c.method !== 'GET') });
}
const existing = (over = {}) => ({ scheduleId: 'scd_old', destination: DESTINATION, cron: '0 * * * *', method: 'POST', retries: 2,
  header: { 'Upstash-Timeout': ['90s'] }, isPaused: false, ...over });
const setup = (argv, fake, env = ENV) => { const out = io(); return runSetup(parseSetupArgs(argv), { io: out, env, fetch: fake.fetch }).then((code) => ({ code, out })); };
const shutdown = (argv, fake, env = ENV) => { const out = io(); return runQStashShutdown(parseShutdownArgs(argv), { io: out, env, fetch: fake.fetch }).then((code) => ({ code, out })); };
const refuses = (promise, exitCode) => assert.rejects(promise, (error) => error instanceof ScriptError && error.exitCode === exitCode, `expected exit ${exitCode}`);
const noToken = (text) => assert.ok(!text.includes(TOKEN), 'the token must not appear in any output');

test('qstash-setup: dry run makes no write call and says what it would create', async () => {
  const fake = fakeQStash();
  const { code, out } = await setup([], fake);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(fake.calls.map((c) => c.method), ['GET']);
  assert.equal(fake.writes().length, 0);
  assert.match(out.lines.join('\n'), /DRY RUN[\s\S]*POST https:\/\/qp-worker\.example\.test\/internal\/reconcile[\s\S]*0 \* \* \* \*[\s\S]*Would create/);
  assert.equal(fake.schedules.length, 0);
});

test('qstash-setup: without a token a dry run calls nothing at all and an apply is refused', async () => {
  const fake = fakeQStash();
  const { code, out } = await setup([], fake, { QP_WORKER_URL: WORKER });
  assert.equal(code, EXIT.OK);
  assert.equal(fake.calls.length, 0);
  assert.match(out.lines.join('\n'), /not looked up/);
  await refuses(setup(APPLY, fake, { QP_WORKER_URL: WORKER }), EXIT.REFUSED);
  assert.equal(fake.calls.length, 0);
});

test('qstash-setup: apply creates one schedule with cron, retries, method and a unit timeout, then confirms by re-read', async () => {
  const fake = fakeQStash();
  const { code, out } = await setup(APPLY, fake);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(fake.calls.map((c) => c.method), ['GET', 'POST', 'GET']);
  const post = fake.writes()[0];
  assert.equal(post.url, `https://qstash.upstash.io/v2/schedules/${DESTINATION}`);
  assert.equal(post.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual({ cron: post.headers['upstash-cron'], method: post.headers['upstash-method'], retries: post.headers['upstash-retries'], timeout: post.headers['upstash-timeout'] },
    { cron: '0 * * * *', method: 'POST', retries: String(DEFAULT_RETRIES), timeout: DEFAULT_TIMEOUT });
  assert.ok(isTimeout(post.headers['upstash-timeout']), 'the timeout carries a unit inside the validated range');
  assert.equal(post.headers['upstash-schedule-id'], undefined, 'a create does not name an id');
  assert.match(out.lines.join('\n'), /created[\s\S]*Confirmed by re-read/);
  assert.equal(fake.schedules.length, 1);
});

test('qstash-setup: re-applying is a no-op (no write call) and never duplicates', async () => {
  const fake = fakeQStash();
  await setup(APPLY, fake);
  fake.calls.length = 0;
  const { code, out } = await setup(APPLY, fake);
  assert.equal(code, EXIT.OK);
  assert.equal(fake.writes().length, 0);
  assert.match(out.lines.join('\n'), /unchanged \(no write made\)/);
  assert.equal(fake.schedules.length, 1);
});

test('qstash-setup: a schedule with other settings is updated in place under its own id, not duplicated', async () => {
  const fake = fakeQStash({ schedules: [existing({ cron: '*/5 * * * *', retries: 0 })] });
  const dry = await setup([], fake);
  assert.match(dry.out.lines.join('\n'), /Would update schedule scd_old in place/);
  assert.equal(fake.writes().length, 0);
  const { code } = await setup(APPLY, fake);
  assert.equal(code, EXIT.OK);
  assert.equal(fake.writes().length, 1);
  assert.equal(fake.writes()[0].headers['upstash-schedule-id'], 'scd_old');
  assert.equal(fake.schedules.length, 1);
  assert.equal(fake.schedules[0].cron, '0 * * * *');
});

test('qstash-setup: a paused schedule counts as different; an unrelated schedule is never touched', async () => {
  const unrelated = existing({ scheduleId: 'scd_other', destination: OTHER, cron: '* * * * *' });
  const fake = fakeQStash({ schedules: [unrelated, existing({ isPaused: true })] });
  await setup(APPLY, fake).catch(() => {}); // the double's upsert un-pauses, so this converges
  assert.equal(fake.writes().length, 1);
  assert.deepEqual(fake.schedules.find((s) => s.scheduleId === 'scd_other'), unrelated);
});

test('qstash-setup: several schedules for the destination stop with a state error and no write', async () => {
  const fake = fakeQStash({ schedules: [existing(), existing({ scheduleId: 'scd_dup' })] });
  await refuses(setup(APPLY, fake), EXIT.STATE);
  assert.equal(fake.writes().length, 0);
});

test('qstash-setup: when the re-read does not show the wanted settings the run fails instead of claiming success', async () => {
  const fake = fakeQStash();
  const real = fake.fetch;
  fake.fetch = async (url, init) => {
    const response = await real(url, init);
    if (init?.method === 'POST') fake.schedules[0].retries = 99; // the service silently stored something else
    return response;
  };
  await refuses(setup(APPLY, fake), EXIT.STATE);
});

test('qstash-setup: approval and usage refusals happen before any network call', async () => {
  const fake = fakeQStash();
  await refuses(setup(['--apply'], fake), EXIT.REFUSED);
  await refuses(setup(['--apply', '--approve-destination', OTHER], fake), EXIT.REFUSED);
  await refuses(setup(['--approve-destination', OTHER], fake), EXIT.REFUSED); // wrong approval is refused even in a dry run
  for (const env of [{ QSTASH_TOKEN: TOKEN }, { ...ENV, QP_WORKER_URL: 'http://qp-worker.example.test' }, { ...ENV, QP_WORKER_URL: 'https://localhost' },
    { ...ENV, QP_WORKER_URL: 'https://127.0.0.1' }, { ...ENV, QP_WORKER_URL: `${WORKER}/path` }, { ...ENV, QP_WORKER_URL: `${WORKER}/` }, { ...ENV, QSTASH_URL: 'http://qstash.example.test' },
    { ...ENV, QSTASH_TOKEN: 'has a space inside it' }]) await refuses(setup([], fake, env), EXIT.USAGE);
  for (const argv of [['--timeout', '60'], ['--timeout', '30s'], ['--timeout', '16m'], ['--timeout', '1h30m'], ['--retries', '4'], ['--retries', '-1'], ['--retries', 'two'],
    ['--cron', '* * * * *'], ['extra'], ['--retries', '1', '--retries', '2']]) {
    await assert.rejects(async () => setup(argv, fake), (error) => error instanceof ScriptError && error.exitCode === EXIT.USAGE, argv.join(' '));
  }
  assert.equal(fake.calls.length, 0);
});

test('qstash-setup: accepts the validated bounds for retries and timeout and sends them', async () => {
  const fake = fakeQStash();
  await setup(['--retries', String(MAX_RETRIES), '--timeout', '15m', ...APPLY], fake);
  assert.equal(fake.writes()[0].headers['upstash-retries'], String(MAX_RETRIES));
  assert.equal(fake.writes()[0].headers['upstash-timeout'], '15m');
  const second = fakeQStash();
  await setup(['--retries', '0', '--timeout', '60s', ...APPLY], second);
  assert.equal(second.writes()[0].headers['upstash-retries'], '0');
});

test('QSTASH_URL selects the region: every call goes to that host', async () => {
  const fake = fakeQStash();
  await setup(APPLY, fake, { ...ENV, QSTASH_URL: 'https://eu-central-1.qstash.example.test' });
  assert.ok(fake.calls.length > 0);
  for (const call of fake.calls) assert.ok(call.url.startsWith('https://eu-central-1.qstash.example.test/v2/schedules'), call.url);
});

test('the token cannot be passed as an argument and never appears in any output or error', async () => {
  const fake = fakeQStash({ echoToken: true });
  for (const argv of [['--token', TOKEN], [`--token=${TOKEN}`], [TOKEN]]) {
    const out = io();
    const code = await runCli(async (args, o) => runSetup(parseSetupArgs(args), { io: o, env: ENV, fetch: fake.fetch }), argv, out);
    assert.equal(code, EXIT.USAGE);
    noToken(out.lines.join('\n'));
  }
  const scenarios = [
    () => setup([], fake), () => setup(APPLY, fake), () => setup(APPLY, fake), () => shutdown([], fake), () => shutdown(APPLY, fake),
    () => setup(APPLY, fakeQStash({ failWith: { status: 401 }, echoToken: true })), () => setup(APPLY, fakeQStash({ failWith: { networkError: true } })),
    () => shutdown(APPLY, fakeQStash({ failWith: { status: 500 }, echoToken: true })), () => setup([], fake, { ...ENV, QSTASH_TOKEN: `${TOKEN} x` }),
  ];
  for (const scenario of scenarios) {
    let text;
    try { text = (await scenario()).out.lines.join('\n'); } catch (error) { text = `${error.message}\n${error.stack}\n${String(error.cause ?? '')}`; }
    noToken(text);
  }
  // Through the real CLI wrapper as well, which also covers the unexpected-error path.
  const out = io();
  const code = await runCli(async (args, o) => runSetup(parseSetupArgs(args), { io: o, env: ENV, fetch: fakeQStash({ failWith: { networkError: true } }).fetch }), APPLY, out);
  assert.equal(code, EXIT.IO);
  noToken(out.lines.join('\n'));
});

test('HTTP failures: 401/403, 429, 5xx and network errors are distinct, value-free, exit 5, and stop before any write', async () => {
  const cases = [
    [{ status: 401 }, /rejected the credentials \(HTTP 401\)/], [{ status: 403 }, /rejected the credentials \(HTTP 403\)/],
    [{ status: 429, headers: { 'retry-after': '120' } }, /rate limit reached \(HTTP 429\); retry after 120 s/],
    [{ status: 429, headers: { 'retry-after': 'soon; drop table' } }, /rate limit reached \(HTTP 429\)$/],
    [{ status: 500 }, /server error \(HTTP 500\)/], [{ status: 503 }, /server error \(HTTP 503\)/], [{ status: 418 }, /request failed \(HTTP 418\)/],
    [{ networkError: true }, /network error/],
  ];
  for (const [failWith, pattern] of cases) {
    for (const run of [setup, shutdown]) {
      const fake = fakeQStash({ failWith, echoToken: true });
      const out = io();
      const code = await runCli(async (argv, o) => (run === setup ? runSetup(parseSetupArgs(argv), { io: o, env: ENV, fetch: fake.fetch }) : runQStashShutdown(parseShutdownArgs(argv), { io: o, env: ENV, fetch: fake.fetch })), APPLY, out);
      assert.equal(code, EXIT.IO, JSON.stringify(failWith));
      assert.match(out.lines.join('\n'), pattern);
      assert.ok(!out.lines.join('\n').includes('denied'), 'a response body is never echoed');
      assert.equal(fake.writes().length, 0, 'a failed read leads to no write');
    }
  }
});

test('a failing write is reported and not retried', async () => {
  const fake = fakeQStash();
  const real = fake.fetch;
  fake.fetch = async (url, init) => (init?.method === 'POST' ? (fake.calls.push({ method: 'POST', url, headers: init.headers }), jsonResponse(429, {}, { 'retry-after': '30' })) : real(url, init));
  const out = io();
  const code = await runCli(async (argv, o) => runSetup(parseSetupArgs(argv), { io: o, env: ENV, fetch: fake.fetch }), APPLY, out);
  assert.equal(code, EXIT.IO);
  assert.equal(fake.writes().length, 1);
  assert.match(out.lines.join('\n'), /rate limit reached/);
});

test('an unexpected listing shape is an I/O error and changes nothing', async () => {
  const fake = fakeQStash();
  fake.fetch = async (url, init) => { fake.calls.push({ method: init?.method ?? 'GET', url, headers: init?.headers }); return jsonResponse(200, { schedules: [] }); };
  await refuses(setup(APPLY, fake), EXIT.IO);
  assert.equal(fake.writes().length, 0);
});

test('qstash-shutdown: dry run lists what it would delete and makes no write call', async () => {
  const fake = fakeQStash({ schedules: [existing(), existing({ scheduleId: 'scd_other', destination: OTHER })] });
  const { code, out } = await shutdown([], fake);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(fake.calls.map((c) => c.method), ['GET']);
  assert.match(out.lines.join('\n'), /Would delete 1 schedule\(s\): scd_old/);
  assert.equal(fake.schedules.length, 2);
});

test('qstash-shutdown: apply deletes only schedules for the exact destination and confirms by re-read', async () => {
  const keep = [existing({ scheduleId: 'scd_other', destination: OTHER }), existing({ scheduleId: 'scd_prefix', destination: `${DESTINATION}/extra` }),
    existing({ scheduleId: 'scd_sibling', destination: `${WORKER}/internal/tasks` })];
  const fake = fakeQStash({ schedules: [existing(), ...keep] });
  const { code, out } = await shutdown(APPLY, fake);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(fake.writes().map((c) => [c.method, c.url.split('/').pop()]), [['DELETE', 'scd_old']]);
  assert.deepEqual(fake.schedules.map((s) => s.scheduleId), ['scd_other', 'scd_prefix', 'scd_sibling']);
  assert.match(out.lines.join('\n'), /scd_old: deleted[\s\S]*Confirmed by re-read/);
});

test('qstash-shutdown: nothing to delete is fine, a second run is a no-op, duplicates are all removed', async () => {
  const none = fakeQStash({ schedules: [existing({ destination: OTHER })] });
  assert.equal((await shutdown(APPLY, none)).code, EXIT.OK);
  assert.equal(none.writes().length, 0);
  const two = fakeQStash({ schedules: [existing(), existing({ scheduleId: 'scd_dup' })] });
  await shutdown(APPLY, two);
  assert.equal(two.schedules.length, 0);
  two.calls.length = 0;
  assert.equal((await shutdown(APPLY, two)).code, EXIT.OK);
  assert.equal(two.writes().length, 0);
});

test('qstash-shutdown: a schedule that is gone by the time of the delete is reported, one that stays fails the run', async () => {
  const gone = fakeQStash({ schedules: [existing()] });
  const real = gone.fetch;
  gone.fetch = async (url, init) => { if (init?.method === 'DELETE') { gone.schedules.length = 0; return jsonResponse(404, {}); } return real(url, init); };
  assert.match((await shutdown(APPLY, gone)).out.lines.join('\n'), /already gone/);
  const stuck = fakeQStash({ schedules: [existing()] });
  stuck.fetch = async (url, init) => { stuck.calls.push({ method: init?.method ?? 'GET', url, headers: init?.headers }); return init?.method === 'DELETE' ? jsonResponse(200, {}) : jsonResponse(200, stuck.schedules); };
  await refuses(shutdown(APPLY, stuck), EXIT.STATE);
});

test('qstash-shutdown: approval, token and URL refusals happen before any network call', async () => {
  const fake = fakeQStash({ schedules: [existing()] });
  await refuses(shutdown(['--apply'], fake), EXIT.REFUSED);
  await refuses(shutdown(['--apply', '--approve-destination', OTHER], fake), EXIT.REFUSED);
  await refuses(shutdown([], fake, { QP_WORKER_URL: WORKER }), EXIT.REFUSED);
  await refuses(shutdown([], fake, { QSTASH_TOKEN: TOKEN }), EXIT.USAGE);
  assert.throws(() => parseShutdownArgs(['--timeout', '90s']), (error) => error instanceof ScriptError && error.exitCode === EXIT.USAGE);
  assert.equal(fake.calls.length, 0);
});

test('the script constants stay in step with packages/core (B9-1 limits and the reconcile route)', () => {
  const config = readFileSync(`${root}packages/core/src/config.ts`, 'utf8');
  assert.match(config, /QSTASH_TIMEOUT_MIN_MS = 60_000/);
  assert.match(config, /QSTASH_TIMEOUT_MAX_MS = 15 \* 60_000/);
  assert.equal(TIMEOUT_MIN_MS, 60_000);
  assert.equal(TIMEOUT_MAX_MS, 15 * 60_000);
  assert.match(config, /QP_QSTASH_RETRIES: z\.string\(\)\.regex\(\/\^\[0-3\]\$\/\)\.default\('2'\)/);
  assert.match(config, new RegExp(`QP_QSTASH_TIMEOUT: .*\\.default\\('${DEFAULT_TIMEOUT}'\\)`));
  assert.equal(MAX_RETRIES, 3);
  assert.equal(DEFAULT_RETRIES, 2);
  assert.match(readFileSync(`${root}packages/core/src/processing/qstash-auth.ts`, 'utf8'), new RegExp(`WORKER_RECONCILE_PATH = '${RECONCILE_PATH}'`));
});
