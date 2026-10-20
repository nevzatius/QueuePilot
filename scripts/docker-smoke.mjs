/* global fetch, AbortSignal, setTimeout */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

// Local container smoke check for an already built image. It starts one throwaway container with
// demo-only settings (no cloud credentials, no network targets), checks the unauthenticated health
// endpoint, the non-root user and graceful SIGTERM exit, and removes only the container it created.
// It never pushes an image or contacts any cloud service.

const { values } = parseArgs({ options: { image: { type: 'string' }, app: { type: 'string' } } });
if (!values.image || !['api', 'worker'].includes(values.app ?? '')) {
  console.error('Usage: node scripts/docker-smoke.mjs --app api|worker --image IMAGE');
  process.exit(2);
}
const { image, app } = values;
const name = `qp-smoke-${app}-${randomBytes(4).toString('hex')}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = false;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${app}: ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed = true;
};

// Demo-only settings; the Firestore emulator address is never contacted by /health.
const env = ['QP_ENV=development', 'GCLOUD_PROJECT=demo-queuepilot', 'FIRESTORE_EMULATOR_HOST=127.0.0.1:8080',
  'QP_REDIS_ENABLED=false', 'QP_WORKER_AUTH_MODE=local', 'PORT=8080'];

try {
  check(Number(docker('run', '--rm', '--entrypoint', 'id', image, '-u')) !== 0, 'runs as a non-root user');

  const prod = spawnSync('docker', ['run', '--rm', '-e', 'QP_ENV=production', '-e', 'GCLOUD_PROJECT=demo-queuepilot', image],
    { encoding: 'utf8', timeout: 60_000 });
  check(prod.status !== 0 && prod.status !== null, 'refuses to start with an unsafe production configuration', `exit ${prod.status}`);

  docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', ...env.flatMap((entry) => ['-e', entry]), image);
  const hostPort = docker('port', name, '8080/tcp').split('\n')[0]?.split(':').pop();
  let healthy = false;
  for (let attempt = 0; attempt < 40 && !healthy; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/health`, { signal: AbortSignal.timeout(2000) });
      healthy = response.ok && (await response.json()).status === 'ok';
    } catch { /* not ready yet */ }
    if (!healthy) await wait(500);
  }
  check(healthy, 'GET /health returns ok');

  const started = Date.now();
  docker('stop', '--time', '10', name);
  const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
  check(state.ExitCode === 0, 'exits 0 after SIGTERM (graceful shutdown, not SIGKILL)', `exit ${state.ExitCode} after ${Date.now() - started} ms`);
  if (failed) console.log(docker('logs', '--tail', '40', name));
} catch (error) {
  failed = true;
  console.error(`FAIL ${app}: ${error instanceof Error ? error.message.split('\n')[0] : 'smoke check crashed'}`);
} finally {
  try { docker('rm', '--force', name); } catch { /* container may not exist */ }
}
process.exitCode = failed ? 1 : 0;
