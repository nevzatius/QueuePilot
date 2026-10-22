import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, ScriptError } from './lib/ops.mjs';
import { doctorMain, minifyServiceAccount, parseEnvFile } from './config-doctor.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PROJECT = 'qp-test-project';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const serviceAccount = (overrides = {}) => ({ type: 'service_account', project_id: PROJECT, client_email: `fake-signer@${PROJECT}.iam.gserviceaccount.com`, private_key: privateKey, ...overrides });
// Recognisable fakes: none of these may appear in anything the doctor prints.
const FAKE = { token: 'FAKE-qstash-token-7f3a91', current: 'FAKE-current-key-4c2d80', next: 'FAKE-next-key-9be615', redisPass: 'FAKE-redis-pass-1d84e7' };
const GOOD = {
  GCLOUD_PROJECT: PROJECT, QP_WORKER_URL: 'https://qp-worker.example.test', QP_CORS_ORIGINS: 'https://qp.web.app,https://qp.firebaseapp.com', QSTASH_URL: 'https://qstash-eu.example.test',
  QSTASH_TOKEN: FAKE.token, QSTASH_CURRENT_SIGNING_KEY: FAKE.current, QSTASH_NEXT_SIGNING_KEY: FAKE.next, REDIS_URL: `rediss://default:${FAKE.redisPass}@redis.example.test:6380`,
  QP_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount()),
};
const SECRET_FRAGMENTS = [FAKE.token, FAKE.current, FAKE.next, FAKE.redisPass, 'BEGIN PRIVATE KEY', privateKey.split('\n')[1], 'example.test', 'fake-signer'];

const dir = mkdtempSync(join(tmpdir(), 'qp-doctor-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
let counter = 0;
const envText = (values) => Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`).join('\n');
const write = (text) => { const path = join(dir, `file-${counter++}.txt`); writeFileSync(path, text); return path; };

async function run(service, values, extra = []) {
  const out = [];
  const err = [];
  const code = await doctorMain(['--service', service, '--env-file', write(envText(values)), ...extra], { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, text: [...out, ...err].join('\n'), out };
}
const verdict = (result) => result.out.filter((line) => /^(PASS|FAIL)/.test(line));
const failing = (result) => { const at = result.out.findIndex((line) => line.startsWith('FAIL')); return at < 0 ? [] : result.out.slice(at + 1).map((line) => line.trim()); };
const assertNoSecrets = (text) => { for (const fragment of SECRET_FRAGMENTS) assert.ok(!text.includes(fragment), `output contains a secret fragment (${fragment.slice(0, 8)}...)`); };

test('a good env file passes for the api and for the worker, and prints no value', async () => {
  for (const service of ['api', 'worker']) {
    const result = await run(service, GOOD);
    assert.equal(result.code, 0, result.text);
    assert.match(verdict(result)[0], /^PASS queuepilot-/);
    assertNoSecrets(result.text);
  }
});

test('the report shows presence and length per variable, and flags outer whitespace separately', async () => {
  const result = await run('api', { ...GOOD, QSTASH_CURRENT_SIGNING_KEY: `${FAKE.current} ` });
  const line = (name) => result.out.find((entry) => entry.startsWith(`  ${name}  `));
  assert.match(line('QSTASH_TOKEN'), /source=env file {2}present=yes {2}length=24 {2}leading\/trailing whitespace=no/);
  assert.match(line('QSTASH_CURRENT_SIGNING_KEY'), new RegExp(`length=${FAKE.current.length + 1}  leading/trailing whitespace=yes`));
  assert.match(line('QP_ENV'), /source=render\.yaml/);
  assertNoSecrets(result.text);
});

test('each broken value is reported by exactly its variable name and reason', async () => {
  const cases = [
    ['trailing space in a signing key', { QSTASH_CURRENT_SIGNING_KEY: `${FAKE.current} ` }, ['QSTASH_CURRENT_SIGNING_KEY  whitespace']],
    ['redis:// instead of rediss://', { REDIS_URL: `redis://default:${FAKE.redisPass}@redis.example.test:6379` }, ['REDIS_URL  not_rediss']],
    ['http worker URL', { QP_WORKER_URL: 'http://qp-worker.example.test' }, ['QP_WORKER_URL  not_https']],
    ['a missing secret', { QSTASH_TOKEN: undefined }, ['QSTASH_TOKEN  missing']],
    ['a value in quotes (quotes are not stripped)', { REDIS_URL: `"${GOOD.REDIS_URL}"` }, ['REDIS_URL  wrong_format']],
    ['a trailing comma in the CORS list', { QP_CORS_ORIGINS: 'https://qp.web.app,' }, ['QP_CORS_ORIGINS  empty_entry']],
    ['malformed service-account JSON', { QP_FIREBASE_SERVICE_ACCOUNT_JSON: `{"type": "service_account", "private_key": "${FAKE.token}` }, ['QP_FIREBASE_SERVICE_ACCOUNT_JSON  invalid_json']],
    ['a key for another project', { QP_FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount({ project_id: 'fake-other-project' })) }, ['QP_FIREBASE_SERVICE_ACCOUNT_JSON  project_mismatch']],
    ['no service-account key at all', { QP_FIREBASE_SERVICE_ACCOUNT_JSON: undefined }, ['QP_FIREBASE_SERVICE_ACCOUNT_JSON  missing']],
  ];
  for (const [label, override, expected] of cases) {
    const result = await run('api', { ...GOOD, ...override });
    assert.equal(result.code, 1, label);
    assert.deepEqual(failing(result), expected, label);
    assertNoSecrets(result.text);
    assert.ok(!result.text.includes('fake-other-project'), label);
  }
});

test('what the loader accepts passes, with a note for blank values: blank QSTASH_URL, space after a CORS comma', async () => {
  const blank = await run('worker', { ...GOOD, QSTASH_URL: '' });
  assert.equal(blank.code, 0, blank.text);
  assert.ok(blank.out.some((line) => line.startsWith('Blank: QSTASH_URL')));
  const spaced = await run('api', { ...GOOD, QP_CORS_ORIGINS: 'https://qp.web.app, https://qp.firebaseapp.com' });
  assert.equal(spaced.code, 0, spaced.text);
  assert.match(spaced.out.find((line) => line.startsWith('  QP_CORS_ORIGINS  ')), /leading\/trailing whitespace=no/);
});

test('--service-account-file: a pretty-printed key passes, and overrides the env file', async () => {
  const pretty = write(JSON.stringify(serviceAccount(), null, 4).replaceAll('\n', '\r\n'));
  const result = await run('api', { ...GOOD, QP_FIREBASE_SERVICE_ACCOUNT_JSON: undefined }, ['--service-account-file', pretty]);
  assert.equal(result.code, 0, result.text);
  assert.match(result.out.find((line) => line.startsWith('  QP_FIREBASE_SERVICE_ACCOUNT_JSON  ')), /source=service-account file/);
  const overridden = await run('api', { ...GOOD, QP_FIREBASE_SERVICE_ACCOUNT_JSON: '{broken' }, ['--service-account-file', pretty]);
  assert.equal(overridden.code, 0, overridden.text);
  assertNoSecrets(result.text + overridden.text);
});

test('--service-account-file: a malformed file is reported as invalid_json, without its content', async () => {
  const bad = write(`{ "private_key": "${FAKE.token}`);
  const result = await run('worker', { ...GOOD, QP_FIREBASE_SERVICE_ACCOUNT_JSON: undefined }, ['--service-account-file', bad]);
  assert.equal(result.code, 1);
  assert.deepEqual(failing(result), ['QP_FIREBASE_SERVICE_ACCOUNT_JSON  invalid_json']);
  assertNoSecrets(result.text);
});

test('minifyServiceAccount equals ConvertFrom-Json | ConvertTo-Json -Compress for a pretty-printed key', () => {
  const object = serviceAccount();
  const minified = minifyServiceAccount(`\uFEFF${JSON.stringify(object, null, 2)}\r\n`);
  assert.ok(!/\n/.test(minified), 'one line');
  assert.equal(minified, JSON.stringify(object));
  assert.deepEqual(JSON.parse(minified), object);
  assert.equal(minifyServiceAccount('{broken'), '{broken', 'not JSON: passed on so the loader names the variable');
});

test('refuses an env file or a key file inside the git repository, before reading it', async () => {
  const inside = join(root, `.config-doctor-test-${process.pid}.txt`);
  writeFileSync(inside, 'X=1');
  try {
    for (const argv of [['--service', 'api', '--env-file', inside], ['--service', 'api', '--env-file', write(envText(GOOD)), '--service-account-file', inside]]) {
      await assert.rejects(doctorMain(argv, { out: () => {}, err: () => {} }), (error) => error instanceof ScriptError && error.exitCode === EXIT.REFUSED && /inside the git repository/.test(error.message));
    }
  } finally { rmSync(inside, { force: true }); }
});

test('usage errors and malformed env files', async () => {
  const io = { out: () => {}, err: () => {} };
  const usage = (argv) => assert.rejects(doctorMain(argv, io), (error) => error instanceof ScriptError && error.exitCode === EXIT.USAGE);
  await usage([]);
  await usage(['--service', 'queue', '--env-file', write('')]);
  await usage(['--service', 'api']);
  const fakeLine = `NOT A VALID LINE ${FAKE.token}`;
  await assert.rejects(doctorMain(['--service', 'api', '--env-file', write(`A=1\n${fakeLine}`)], io), (error) => error.exitCode === EXIT.USAGE && /line 2/.test(error.message) && !error.message.includes(FAKE.token));
  await assert.rejects(doctorMain(['--service', 'api', '--env-file', write('A=1\nA=2')], io), (error) => error.exitCode === EXIT.USAGE && /A is set twice/.test(error.message));
  await assert.rejects(doctorMain(['--service', 'api', '--env-file', join(dir, 'does-not-exist.txt')], io), (error) => error.exitCode === EXIT.IO);
});

test('parseEnvFile rules: comments and blanks ignored, value kept exactly, first = splits, CRLF and BOM handled', () => {
  const parsed = parseEnvFile('\uFEFF# comment\r\n\r\n   # indented comment\r\nA=1\r\nB= two \r\nC="q"\r\nD=x=y\r\nE=\r\n');
  assert.deepEqual([...parsed], [['A', '1'], ['B', ' two '], ['C', '"q"'], ['D', 'x=y'], ['E', '']]);
  assert.throws(() => parseEnvFile(' A=1'), ScriptError);
  assert.throws(() => parseEnvFile('export A=1'), ScriptError);
});

test('names that the service does not take from the dashboard are ignored and listed by name only', async () => {
  const result = await run('worker', { ...GOOD, QP_CORS_ORIGINS: 'https://x.example.test', QP_ENV: 'development', EXTRA_FAKE_NAME: FAKE.token });
  assert.equal(result.code, 0, result.text);
  const ignored = result.out.find((line) => line.startsWith('Ignored'));
  assert.match(ignored, /QP_CORS_ORIGINS/);
  assert.match(ignored, /QP_ENV/);
  assertNoSecrets(result.text);
});

test('the command line: exit codes, and nothing secret on stdout or stderr', () => {
  const script = join(root, 'scripts/config-doctor.mjs');
  const good = spawnSync(process.execPath, [script, '--service', 'api', '--env-file', write(envText(GOOD))], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /PASS queuepilot-api/);
  const bad = spawnSync(process.execPath, [script, '--service', 'api', '--env-file', write(envText({ ...GOOD, QSTASH_NEXT_SIGNING_KEY: `${FAKE.next}\t` }))], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /QSTASH_NEXT_SIGNING_KEY {2}whitespace/);
  const inside = spawnSync(process.execPath, [script, '--service', 'api', '--env-file', join(root, 'render.yaml')], { encoding: 'utf8' });
  assert.equal(inside.status, EXIT.REFUSED);
  for (const result of [good, bad, inside]) assertNoSecrets(result.stdout + result.stderr);
});
