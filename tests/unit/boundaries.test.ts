import path from 'node:path';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const eslint = new ESLint();
const violations = async (file: string, code: string) => {
  const results = await eslint.lintText(code, { filePath: path.resolve(file) });
  return results.flatMap((result) => result.messages).filter((message) => message.ruleId === 'architecture/dependencies');
};

describe('architecture import boundaries', () => {
  beforeAll(async () => {
    await eslint.calculateConfigForFile(path.resolve('apps/api/src/index.ts'));
  }, 30_000);

  it.each([
    ['apps/web/src/check.ts', "import '@queuepilot/core';"],
    ['apps/web/src/check.ts', "import '../../../packages/core/src/index.js';"],
    ['packages/core/src/check.ts', "export * from '@queuepilot/api';"],
    ['packages/domain/src/check.ts', "await import('@queuepilot/core');"],
    ['packages/domain/src/check.ts', "import 'node:fs/promises';"],
    ['packages/domain/src/check.ts', "import 'redis';"],
    ['packages/contracts/src/check.ts', "import '@queuepilot/domain';"],
    ['packages/contracts/src/check.ts', "import 'node:http';"],
    ['apps/api/src/check.ts', "export * from '../../worker/src/index.js';"],
  ])('rejects %s: %s', async (file, code) => {
    expect(await violations(file, code)).toHaveLength(1);
  });

  it.each([
    ['apps/api/src/check.ts', "import '@queuepilot/core';"],
    ['apps/worker/src/check.ts', "import '@queuepilot/domain';"],
    ['apps/web/src/check.ts', "import '@queuepilot/contracts';"],
    ['packages/core/src/check.ts', "import '@queuepilot/contracts';"],
    ['packages/core/src/check.ts', "import './index.js';"],
    ['packages/domain/src/check.ts', "import 'node:crypto';"],
    ['packages/domain/src/check.ts', "import '@queuepilot/contracts';"],
    ['packages/contracts/src/check.ts', "import 'zod';"],
    ['packages/contracts/test/check.test.ts', "import 'vitest';"],
  ])('allows %s: %s', async (file, code) => {
    expect(await violations(file, code)).toHaveLength(0);
  });
});
