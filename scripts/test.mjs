import { spawnSync } from 'node:child_process';

// Root unit gate: node-env suites, the web jsdom suite and the offline infrastructure and owner-script tests.
const execpath = process.env.npm_execpath;
if (!execpath) throw new Error('Run through the root pnpm test script');
const steps = [
  [process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.ts']],
  [process.execPath, [execpath, '--filter', '@queuepilot/web', 'test']],
  [process.execPath, ['--test', 'infra/offline.test.mjs', 'infra/targeted.test.mjs', 'scripts/scripts.test.mjs']],
];
for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
