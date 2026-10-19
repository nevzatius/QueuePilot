import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/{src,test,tests}/**/*.test.ts', 'apps/api/{src,test,tests}/**/*.test.ts', 'apps/worker/{src,test,tests}/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/integration/**'],
    clearMocks: true,
    restoreMocks: true,
  },
});
