import { spawnSync } from 'node:child_process';

// Run every suite inside the one emulators:exec lifetime, preserving any failure.
const suites = [
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts'],
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/web/vitest.smoke.config.ts'],
  ['apps/worker/test/build-smoke.mjs'],
];
let failed = false;
for (const args of suites) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
