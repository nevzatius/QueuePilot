import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, ScriptError, parseOptions, runCli } from './lib/ops.mjs';
import { runPreflight, summarize } from './lib/preflight.mjs';
import { cloudSummary, runCloudPreflight } from './lib/cloud-preflight.mjs';
import { loadScope } from './lib/cloud-ops.mjs';
import { accessToken, cloudClient } from '../infra/cloud.mjs';

// Local deployment preflight: PASS = verified locally, FAIL = repository inconsistency,
// BLOCKED = a local tool/artifact/configuration is missing, NOT_RUN = external verification, never run here.
// No network, no gcloud call, no environment values printed. Exit: 0 ok, 1 FAIL, 2 required BLOCKED
// (or any BLOCKED with --strict).
//
//   node scripts/preflight.mjs [--config C] [--project P] [--region europe-west1] [--json] [--strict]
//   node scripts/preflight.mjs --profile free     (adds render.yaml / firebase.json consistency checks; no network)
//
// Cloud read mode (opt-in, owner credentials): GET requests only, never a write. Statuses PASS / FAIL /
// ABSENT / UNKNOWN; exit 1 on FAIL, 3 on UNKNOWN, 0 otherwise.
//   node scripts/preflight.mjs --config C --project P --region europe-west1 --run --approve-project P [--json]

const OPTIONS = {
  config: { type: 'string' }, project: { type: 'string' }, region: { type: 'string' },
  json: { type: 'boolean', default: false }, strict: { type: 'boolean', default: false },
  run: { type: 'boolean', default: false }, 'approve-project': { type: 'string' }, profile: { type: 'string' },
};
const root = fileURLToPath(new URL('..', import.meta.url));

function walk(directory, depth = 0, found = []) {
  if (depth > 4) return found;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, found);
    else found.push(relative(root, full).replaceAll('\\', '/'));
  }
  return found;
}

// `--version` probes only: they print a version, change nothing and need no network.
const hasTool = (name) => !spawnSync(name, ['--version'], { stdio: 'ignore', shell: false }).error;

/** Wraps a cloud client so that anything other than a body-less GET throws before reaching the network. */
export const readOnly = (client) => async (host, path, method = 'GET', body) => {
  if (method !== 'GET' || body !== undefined) throw new ScriptError(EXIT.IO, 'preflight is read-only; refusing a non-GET request');
  return client(host, path);
};

export async function cloudPreflightMain(values, io, deps) {
  if (!values.config) throw new ScriptError(EXIT.USAGE, '--run needs --config');
  const config = loadScope({ configText: deps.readFile(values.config), project: values.project, region: values.region,
    approveProject: values['approve-project'], apply: false, requireImages: false });
  if (values['approve-project'] !== config.projectId) throw new ScriptError(EXIT.REFUSED, '--run needs --approve-project=<project> (exact match)');
  const results = await runCloudPreflight(config, readOnly(deps.client()));
  const summary = cloudSummary(results);
  if (values.json) io.out(JSON.stringify({ mode: 'cloud read-only', results, ...summary }, null, 2));
  else {
    for (const r of results) io.out(`[${r.status}] ${r.id}: ${r.detail}`);
    io.out(summary.failed ? 'RESULT: FAIL: the project contradicts the plan or a safety rule.'
      : summary.unknown ? 'RESULT: UNKNOWN: some reads were denied or failed; nothing is assumed.'
        : 'RESULT: read-only checks found no contradiction. ABSENT items are created by later stages. This is not C1-C9 evidence.');
  }
  return summary.exitCode;
}

export function preflightMain(argv, io, env = process.env) {
  const values = parseOptions(argv, OPTIONS);
  if (values.profile !== undefined && values.profile !== 'free') throw new ScriptError(EXIT.USAGE, '--profile must be free');
  if (values.profile !== undefined && values.run) throw new ScriptError(EXIT.USAGE, '--profile is a local check and cannot be combined with --run');
  if (values.run) {
    return cloudPreflightMain(values, io, {
      readFile: (path) => { try { return readFileSync(path, 'utf8'); } catch { throw new ScriptError(EXIT.USAGE, 'Cannot read the configuration file'); } },
      client: () => { try { return cloudClient(accessToken()); } catch { throw new ScriptError(EXIT.IO, 'No gcloud access token; run `gcloud auth login` as the owner'); } },
    });
  }
  if (values['approve-project'] !== undefined) throw new ScriptError(EXIT.USAGE, '--approve-project is only used with --run');
  let configText;
  if (values.config) {
    try { configText = readFileSync(values.config, 'utf8'); } catch { throw new ScriptError(EXIT.USAGE, 'Cannot read the configuration file'); }
  }
  const results = runPreflight({
    read: (path) => readFileSync(join(root, path), 'utf8'), exists: (path) => existsSync(join(root, path)),
    listFiles: () => walk(root), env, tool: hasTool, nodeVersion: process.version,
    args: { config: values.config, configText, project: values.project, region: values.region, profile: values.profile },
  });
  const summary = summarize(results, values.strict);
  if (values.json) io.out(JSON.stringify({ results, ...summary }, null, 2));
  else {
    for (const r of results) io.out(`[${r.status.replace('_', ' ')}] ${r.id}: ${r.detail}`);
    io.out(summary.failed ? 'RESULT: FAIL: repository inconsistencies found.'
      : summary.blocked ? 'RESULT: BLOCKED: required local prerequisites are missing.'
        : 'RESULT: local checks passed. This does NOT show that any cloud resource exists or that C1-C9 passed.');
  }
  return summary.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(async (argv, io) => preflightMain(argv, io), process.argv.slice(2));
}
