import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const result = spawnSync(process.execPath, [
  'node_modules/firebase-tools/lib/bin/firebase.js',
  'emulators:exec', '--project', 'demo-queuepilot', '--only', 'auth,firestore',
  'node node_modules/vitest/vitest.mjs run --config apps/api/vitest.integration.config.ts apps/api/test/integration',
], { cwd: root, stdio: 'inherit', env: { ...process.env, DEBUG: '', GCLOUD_PROJECT: 'demo-queuepilot' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
