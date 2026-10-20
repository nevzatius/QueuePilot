/* global fetch, AbortSignal, setTimeout */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { FORBIDDEN_VARIANTS, PRODUCTION_ENV } from './lib/smoke-env.mjs';

// Container smoke check for an already built image. It starts throwaway containers with synthetic,
// production-shaped settings (scripts/lib/smoke-env.mjs: no credentials, no reachable cloud target),
// prints one PASS/FAIL line per check it actually ran, and removes only the containers it created.
// It never pushes an image or contacts any cloud service on purpose.

const { values } = parseArgs({ options: { image: { type: 'string' }, app: { type: 'string' } } });
if (!values.image || !['api', 'worker'].includes(values.app ?? '')) {
  console.error('Usage: node scripts/docker-smoke.mjs --app api|worker --image IMAGE');
  process.exit(2);
}
const { image, app } = values;
const name = `qp-smoke-${app}-${randomBytes(4).toString('hex')}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inImage = (script) => spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', script], { encoding: 'utf8', timeout: 60_000 });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const envFlags = (env) => Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
const executed = [];
const check = (ok, label, detail = '') => {
  executed.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${app}: ${label}${detail ? ` (${detail})` : ''}`);
};

try {
  // 1. Identity and file set of the runtime image.
  check(Number(docker('run', '--rm', '--entrypoint', 'id', image, '-u')) !== 0, 'runs as a non-root user');
  const listing = inImage('cd /app && ls -A && echo --- && ls -A dist');
  check(listing.status === 0 && listing.stdout.trim() === 'dist\nnode_modules\npackage.json\n---\nserver.js\nserver.js.map',
    '/app holds only package.json, node_modules and dist/server.js(.map)');
  // Repository files can reach /app only outside node_modules, or inside it as workspace packages; registry packages
  // under node_modules legitimately ship their own *.test.d.ts and fixtures, so they are not scanned by name.
  const stray = inImage("find /app -path /app/node_modules -prune -o \\( -name '.env*' -o -name '.git' -o -name '*.pem' -o -name '*.key' "
    + "-o -name '*credentials*.json' -o -name 'service-account*.json' -o -name '*.test.*' \\) -print; "
    + 'ls -d /app/node_modules/@queuepilot /app/node_modules/.pnpm/re2@* 2>/dev/null; true');
  check(stray.status === 0 && stray.stdout.trim() === '', 'no repository env/key/git/test files, no workspace sources, no re2 native module', stray.stdout.trim().split('\n')[0]);
  const writable = inImage('test -w /app/dist/server.js || test -w /app/node_modules || touch /app/smoke 2>/dev/null; echo $?');
  check(writable.stdout.trim() === '1', 'application files are read-only for the runtime user');

  // 2. Startup guards: each forbidden production setting must stop the process with its specific reason.
  for (const variant of FORBIDDEN_VARIANTS) {
    const run = spawnSync('docker', ['run', '--rm', ...envFlags({ ...PRODUCTION_ENV, ...variant.env }), image], { encoding: 'utf8', timeout: 60_000 });
    const output = `${run.stdout}${run.stderr}`;
    check(run.status !== 0 && run.status !== null && output.includes(variant.error), `refuses to start: ${variant.label}`, `exit ${run.status}`);
  }

  // 3. Production-shaped start, health, worker fail-closed, graceful SIGTERM.
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', ...envFlags(PRODUCTION_ENV), image);
  const hostPort = docker('port', name, '8080/tcp').split('\n')[0]?.split(':').pop();
  const base = `http://127.0.0.1:${hostPort}`;
  let healthy = false;
  for (let attempt = 0; attempt < 40 && !healthy; attempt++) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      healthy = response.ok && (await response.json()).status === 'ok';
    } catch { /* not ready yet */ }
    if (!healthy) await wait(500);
  }
  check(healthy, 'GET /health returns ok with production settings');
  if (app === 'worker') {
    for (const path of ['/internal/tasks', '/internal/reconcile']) {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(5000) }).catch(() => null);
      check(response?.status === 403, `POST ${path} without a token is rejected`, `status ${response?.status ?? 'none'}`);
    }
  }
  const started = Date.now();
  docker('stop', '--time', '10', name);
  const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
  check(state.ExitCode === 0, 'exits 0 after SIGTERM (graceful shutdown, not SIGKILL)', `exit ${state.ExitCode} after ${Date.now() - started} ms`);
  console.log(`INFO ${app}: image size ${docker('image', 'inspect', '--format', '{{.Size}}', image)} bytes`);
  if (executed.some((c) => !c.ok)) console.log(docker('logs', '--tail', '40', name));
} catch (error) {
  check(false, 'smoke run completed', error instanceof Error ? error.message.split('\n')[0] : 'crashed');
} finally {
  try { docker('rm', '--force', name); } catch { /* container may not exist */ }
}
const failed = executed.filter((c) => !c.ok).length;
console.log(`SUMMARY ${app}: ${executed.length - failed}/${executed.length} executed checks passed`);
process.exitCode = failed ? 1 : 0;
