import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Reserve a fresh ephemeral port; never touch occupied demo/emulator ports.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const { port } = probe.address();
await new Promise((resolve) => probe.close(resolve));
const workerUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, DEBUG: '', QP_ENV: 'test', GCLOUD_PROJECT: 'demo-queuepilot',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    PORT: String(port), QP_WORKER_URL: workerUrl, QP_QUEUE_ADAPTER: 'local', QP_WORKER_AUTH_MODE: 'oidc',
    QP_TASKS_OIDC_AUDIENCE: workerUrl, QP_TASKS_INVOKER_SA: 'qp-tasks-invoker-sa@demo-queuepilot.iam.gserviceaccount.com' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let output = '';
child.stdout.on('data', (value) => { output += value.toString(); });
child.stderr.on('data', (value) => { output += value.toString(); });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Worker exited at startup: ${output}`);
    try {
      const response = await globalThis.fetch(`${workerUrl}/ready`, { signal: globalThis.AbortSignal.timeout(1000) });
      if (response.status === 200) { assert.deepEqual(await response.json(), { status: 'ready' }); ready = true; break; }
    } catch { /* Wait for startup. */ }
    await setTimeout(50);
  }
  assert.ok(ready, `Built worker did not become ready: ${output}`);
  for (const path of ['/internal/tasks', '/internal/reconcile']) {
    const denied = await globalThis.fetch(`${workerUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
  }
  console.log('Built worker smoke: 3 assertions passed (ready + task auth + scheduler auth)');
} finally {
  if (child.exitCode === null && child.connected) {
    const exited = once(child, 'exit');
    child.send('shutdown');
    await exited;
  }
}
