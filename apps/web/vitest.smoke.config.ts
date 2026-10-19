import { defineConfig } from 'vitest/config';

// Pin the root so the suite is found when invoked from the repo root (scripts/integration.mjs).
export default defineConfig({
  root: import.meta.dirname,
  test: { environment: 'node', include: ['smoke/**/*.smoke.ts'], testTimeout: 15_000, hookTimeout: 30_000 },
});
