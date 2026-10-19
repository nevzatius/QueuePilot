import { spawnSync } from 'node:child_process';

// Always select a demo project; no login or cloud credentials are needed.
const result = spawnSync(process.execPath, [
  'node_modules/firebase-tools/lib/bin/firebase.js',
  'emulators:exec', '--project', 'demo-queuepilot', '--only', 'auth,firestore',
  'node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts',
], {
  stdio: 'inherit',
  env: { ...process.env, DEBUG: '', GCLOUD_PROJECT: 'demo-queuepilot' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
