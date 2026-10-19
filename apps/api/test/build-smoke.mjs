import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const { port } = probe.address();
await new Promise((resolve) => probe.close(resolve));
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
  env: { ...process.env, DEBUG: '', QP_ENV: 'test', GCLOUD_PROJECT: 'demo-queuepilot',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (value) => { output += value.toString(); });
child.stderr.on('data', (value) => { output += value.toString(); });
try {
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`API exited at startup: ${output}`);
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok' });
      healthy = true;
      break;
    } catch { await setTimeout(50); }
  }
  assert.ok(healthy, 'Built API did not become healthy');
  const denied = await globalThis.fetch(`http://127.0.0.1:${port}/api/v1/requests`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, 'UNAUTHENTICATED');
  console.log('Built API smoke test passed (health + auth boundary)');
} finally {
  if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
}
