import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from './scripts/eslint-boundaries.mjs';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '.firebase/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
    plugins: { architecture: boundaries },
    rules: { 'architecture/dependencies': 'error' },
  },
);
