import { spawnSync } from 'node:child_process';

// npm_execpath points to the running pnpm, including when invoked via Corepack.
// A nested bare `pnpm` command would require a globally installed PATH shim.
const execpath = process.env.npm_execpath;
const script = process.argv[2];
if (!execpath || !['typecheck', 'build'].includes(script)) {
  throw new Error('Run through the root pnpm typecheck or build script');
}
const result = spawnSync(process.execPath, [execpath, '-r', '--if-present', script], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
