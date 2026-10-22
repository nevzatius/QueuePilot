import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // Development only: with VITE_API_BASE_URL empty the app calls /api on the dev server, which forwards here.
  server: {
    proxy: { '/api': loadEnv(mode, process.cwd(), 'VITE_').VITE_DEV_API_PROXY || 'http://localhost:8080' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    clearMocks: true,
    restoreMocks: true,
  },
}));
