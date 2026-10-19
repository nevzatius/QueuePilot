import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../../scripts/integration-suites.mjs', import.meta.url), 'utf8')
  .replace("import { spawnSync } from 'node:child_process';", '');

describe('integration suite orchestration', () => {
  it.each([0, 1, 2])('runs every suite and preserves failure of suite %s', (index) => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    spawnSync.mockReturnValueOnce({ status: index === 0 ? 1 : 0 })
      .mockReturnValueOnce({ status: index === 1 ? 1 : 0 })
      .mockReturnValueOnce({ status: index === 2 ? 1 : 0 });
    const process = { execPath: 'node', env: { SYNTHETIC: 'true' }, exitCode: undefined as number | undefined };
    runInNewContext(source, { spawnSync, process });
    expect(spawnSync).toHaveBeenCalledTimes(3);
    expect(spawnSync.mock.calls.map((call) => call[1])).toEqual([
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts'],
      ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/web/vitest.smoke.config.ts'],
      ['apps/worker/test/build-smoke.mjs'],
    ]);
    expect(process.exitCode).toBe(1);
  });
  it.each([{ status: null, error: new Error('spawn blocked') }, { status: null, signal: 'SIGTERM' }])('continues after spawn errors or signals', (failure) => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 }).mockReturnValueOnce(failure);
    const process = { execPath: 'node', env: {}, exitCode: undefined as number | undefined };
    runInNewContext(source, { spawnSync, process });
    expect(spawnSync).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBe(1);
  });
  it('succeeds only when every suite succeeds', () => {
    const spawnSync = vi.fn().mockReturnValue({ status: 0 });
    const process = { execPath: 'node', env: {}, exitCode: undefined as number | undefined };
    runInNewContext(source, { spawnSync, process });
    expect(process.exitCode).toBe(0);
  });
});
