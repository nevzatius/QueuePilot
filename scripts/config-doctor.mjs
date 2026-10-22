import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, ScriptError, parseOptions, runCli } from './lib/ops.mjs';
import { parseBlueprint } from './lib/render-yaml.mjs';

// Configuration doctor for the free-tier deployment (ADR-019). Builds the environment one Render service would get:
// the fixed `value:` entries of render.yaml, plus the `sync: false` entries taken from a local env file (and, optionally,
// a service-account key file), then runs the SAME loader the service runs at startup (packages/core loadConfig) and
// reports PASS, or FAIL with the NAMES of the failing variables and a reason code. No network, no cloud call.
//
//   node scripts/config-doctor.mjs --service api|worker --env-file D:\queuepilot-secrets\secrets.txt [--service-account-file D:\queuepilot-secrets\key.json]
//
// Output: variable names, presence, length and a whitespace flag; never a value, never a line of the env file.
// Exit: 0 PASS, 1 FAIL (the configuration is rejected), 2 usage or a malformed env file, 3 refused (a secrets file inside
// the git repository), 5 a file cannot be read.
//
// Env file rules (exact; there are no surprises beyond these):
//   - Lines end with LF or CRLF; a leading UTF-8 byte order mark is dropped.
//   - A line that is empty or whitespace only, or whose first non-space character is #, is ignored.
//   - Any other line is NAME=VALUE: NAME is letters, digits and underscores (not starting with a digit) with nothing before it;
//     VALUE is everything after the FIRST "=" exactly as written. Nothing is trimmed, no quote is stripped (a quote
//     stays part of the value, as it would if pasted into the dashboard), and there is no escape or ${...} expansion.
//   - A repeated NAME is an error. Only a NAME that render.yaml declares with `sync: false` for the chosen service is used;
//     any other NAME is ignored and listed (name only).
//   - The service-account file is read as JSON and re-serialised on one line, which is what
//     `Get-Content KEY.json -Raw | ConvertFrom-Json | ConvertTo-Json -Compress` produces (up to escaping that JSON.parse
//     undoes). It overrides QP_FIREBASE_SERVICE_ACCOUNT_JSON from the env file. A file that is not JSON is passed on as it
//     is, so the loader reports the variable as invalid_json.
// RENDER=true is set because Render sets it at runtime (it makes the service-account key mandatory). The local process
// environment is NOT used.

const OPTIONS = { service: { type: 'string' }, 'env-file': { type: 'string' }, 'service-account-file': { type: 'string' } };
const root = fileURLToPath(new URL('..', import.meta.url));
const SERVICES = { api: 'queuepilot-api', worker: 'queuepilot-worker' };
const SERVICE_ACCOUNT_VAR = 'QP_FIREBASE_SERVICE_ACCOUNT_JSON';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** KEY=VALUE lines, by the rules in the header. Errors carry a line number, never the line. */
export function parseEnvFile(text) {
  const values = new Map();
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const at = line.indexOf('=');
    const name = at < 0 ? '' : line.slice(0, at);
    if (!NAME.test(name)) throw new ScriptError(EXIT.USAGE, `Env file line ${index + 1}: expected NAME=VALUE (a NAME of letters, digits and underscores, starting at column 1)`);
    if (values.has(name)) throw new ScriptError(EXIT.USAGE, `Env file line ${index + 1}: ${name} is set twice`);
    values.set(name, line.slice(at + 1));
  });
  return values;
}

/** One-line JSON, like ConvertFrom-Json | ConvertTo-Json -Compress. Not JSON: returned unchanged so the loader names the variable. */
export function minifyServiceAccount(text) {
  try { return JSON.stringify(JSON.parse(text.replace(/^\uFEFF/, ''))); } catch { return text; }
}

/** True when the path is inside this repository (symlinks resolved). Secrets must live outside it. */
export function isInsideRepository(path, repoRoot = root) {
  let real;
  try { real = realpathSync(path); } catch { real = resolve(path); }
  const within = relative(realpathSync(repoRoot), real);
  return within === '' || (!within.startsWith('..') && !isAbsolute(within));
}

/** The environment Render would give `service`: fixed values from the blueprint, then dashboard values from the files. */
export function buildEnvironment({ blueprintText, service, envFile, serviceAccountText }) {
  const blueprint = parseBlueprint(blueprintText);
  const entry = (blueprint.services ?? []).find((candidate) => candidate.name === SERVICES[service]);
  if (!entry) throw new ScriptError(EXIT.IO, `render.yaml has no service ${SERVICES[service]}`);
  const env = { RENDER: 'true' };
  const declared = [];
  const dashboard = new Set();
  for (const variable of entry.envVars ?? []) {
    declared.push(variable.key);
    if (Object.hasOwn(variable, 'value')) env[variable.key] = String(variable.value);
    else dashboard.add(variable.key);
  }
  const ignored = [];
  const source = Object.fromEntries(declared.map((key) => [key, Object.hasOwn(env, key) ? 'render.yaml' : 'missing']));
  for (const [key, value] of envFile ?? []) {
    if (dashboard.has(key)) { env[key] = value; source[key] = 'env file'; } else ignored.push(key);
  }
  if (serviceAccountText !== undefined) { env[SERVICE_ACCOUNT_VAR] = minifyServiceAccount(serviceAccountText); source[SERVICE_ACCOUNT_VAR] = 'service-account file'; }
  return { env, declared, source, ignored };
}

const yesNo = (flag) => (flag ? 'yes' : 'no');

/** Presence, length and a whitespace flag per declared variable. Lengths and flags only. */
export function describeVariables({ env, declared, source }) {
  return declared.map((key) => {
    const value = env[key];
    const present = value !== undefined;
    return `  ${key}  source=${source[key]}  present=${yesNo(present)}  length=${present ? value.length : 0}  leading/trailing whitespace=${yesNo(present && value !== value.trim())}`;
  });
}

async function loadLoader() {
  // The .ts source is imported directly (Node strips the types); zod resolves from packages/core.
  return import(pathToFileURL(join(root, 'packages/core/src/config.ts')).href);
}

export async function doctorMain(argv, io, deps = {}) {
  const values = parseOptions(argv, OPTIONS);
  const service = values.service;
  if (!Object.hasOwn(SERVICES, service ?? '')) throw new ScriptError(EXIT.USAGE, '--service must be api or worker');
  if (!values['env-file']) throw new ScriptError(EXIT.USAGE, '--env-file is required');
  const read = deps.readFile ?? ((path) => readFileSync(path, 'utf8'));
  const repoRoot = deps.root ?? root;
  const files = [['env file', values['env-file']], ...(values['service-account-file'] ? [['service-account file', values['service-account-file']]] : [])];
  for (const [label, path] of files) {
    if (isInsideRepository(path, repoRoot)) throw new ScriptError(EXIT.REFUSED, `Refusing: the ${label} is inside the git repository. Keep secrets outside it (for example D:\\queuepilot-secrets).`);
  }
  const text = (label, path) => { try { return read(path); } catch { throw new ScriptError(EXIT.IO, `Cannot read the ${label}`); } };
  const built = buildEnvironment({
    blueprintText: read(join(repoRoot, 'render.yaml')), service,
    envFile: parseEnvFile(text('env file', values['env-file'])),
    serviceAccountText: values['service-account-file'] ? text('service-account file', values['service-account-file']) : undefined,
  });
  io.out(`config-doctor: ${SERVICES[service]} (render.yaml + env file; local only, no network, values are never printed)`);
  for (const line of describeVariables(built)) io.out(line);
  if (built.ignored.length) io.out(`Ignored (not a dashboard value of this service): ${built.ignored.join(', ')}`);
  const blank = built.declared.filter((key) => built.env[key] !== undefined && built.env[key].trim() === '');
  if (blank.length) io.out(`Blank: ${blank.join(', ')} (the loader treats a blank QSTASH_URL as its default; a blank secret counts as missing)`);
  const { loadConfig, ConfigError } = await (deps.loader ?? loadLoader)();
  try {
    loadConfig(built.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) { io.out(`FAIL ${SERVICES[service]}: the loader rejected the configuration without naming a variable`); return 1; }
    io.out(`FAIL ${SERVICES[service]}: ${error.issues.length} variable(s) rejected`);
    for (const { name, reason } of error.issues) io.out(`  ${name}  ${reason}`);
    if (error.issues.length === 0) io.out('  (no variable could be named)');
    return 1;
  }
  io.out(`PASS ${SERVICES[service]}: the loader accepts this configuration. This does not show that the values are correct for the real services.`);
  return EXIT.OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli((argv, io) => doctorMain(argv, io), process.argv.slice(2));
}
