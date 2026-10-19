import { defineConfig } from 'vitest/config';

// B3 stays inside API ownership. Integration owner can add this glob to the root config at merge.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/test/integration/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
