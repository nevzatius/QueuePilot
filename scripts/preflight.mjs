import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXIT, ScriptError, parseOptions, runCli } from './lib/ops.mjs';
import { runPreflight, summarize } from './lib/preflight.mjs';

// Local deployment preflight: PASS = verified locally, FAIL = repository inconsistency,
// BLOCKED = a local tool/artifact/configuration is missing, NOT_RUN = external verification, never run here.
// No network, no gcloud call, no environment values printed. Exit: 0 ok, 1 FAIL, 2 required BLOCKED
// (or any BLOCKED with --strict).
//
//   node scripts/preflight.mjs [--config C] [--project P] [--region europe-west1] [--json] [--strict]

const OPTIONS = {
  config: { type: 'string' }, project: { type: 'string' }, region: { type: 'string' },
  json: { type: 'boolean', default: false }, strict: { type: 'boolean', default: false },
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

export function preflightMain(argv, io, env = process.env) {
  const values = parseOptions(argv, OPTIONS);
  let configText;
  if (values.config) {
    try { configText = readFileSync(values.config, 'utf8'); } catch { throw new ScriptError(EXIT.USAGE, 'Cannot read the configuration file'); }
  }
  const results = runPreflight({
    read: (path) => readFileSync(join(root, path), 'utf8'), exists: (path) => existsSync(join(root, path)),
    listFiles: () => walk(root), env, tool: hasTool, nodeVersion: process.version,
    args: { config: values.config, configText, project: values.project, region: values.region },
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
