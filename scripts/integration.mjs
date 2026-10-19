import { spawnSync } from 'node:child_process';

// Always select a demo project; no login or cloud credentials are needed.
// The frontend-to-API smoke test spawns apps/api/dist/server.js, so `pnpm build` must run first.
const result = spawnSync(process.execPath, [
  'node_modules/firebase-tools/lib/bin/firebase.js',
  'emulators:exec', '--project', 'demo-queuepilot', '--only', 'auth,firestore',
  'node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts'
  + ' && node node_modules/vitest/vitest.mjs run --config apps/web/vitest.smoke.config.ts'
  // Worker smoke uses the same emulator lifetime and shuts down its own child over IPC.
  + ' && node apps/worker/test/build-smoke.mjs',
], {
  stdio: 'inherit',
  env: { ...process.env, DEBUG: '', GCLOUD_PROJECT: 'demo-queuepilot' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
