import { z } from 'zod';

const EnvSchema = z.object({
  VITE_API_BASE_URL: z.string().default(''),
  VITE_FIREBASE_API_KEY: z.string().default(''),
  VITE_FIREBASE_AUTH_DOMAIN: z.string().default(''),
  VITE_FIREBASE_PROJECT_ID: z.string().default(''),
  VITE_FIREBASE_APP_ID: z.string().default(''),
  VITE_FIREBASE_AUTH_EMULATOR_URL: z.string().default(''),
  VITE_USE_MOCK_API: z.string().default('false'),
});

export interface AppConfig {
  /** Origin of the API without a trailing slash. Empty means same-origin. */
  apiBaseUrl: string;
  firebase: { apiKey: string; authDomain: string; projectId: string; appId: string } | null;
  authEmulatorUrl: string | null;
  /** Development-only mock API and fake sign-in. Never true in a production build. */
  useMock: boolean;
}

/** Parses `import.meta.env`-shaped input. `isDev` is injected so tests can cover both modes. */
export function parseConfig(env: Record<string, unknown>, isDev: boolean): AppConfig {
  const e = EnvSchema.parse(env);
  const firebase = {
    apiKey: e.VITE_FIREBASE_API_KEY,
    authDomain: e.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: e.VITE_FIREBASE_PROJECT_ID,
    appId: e.VITE_FIREBASE_APP_ID,
  };
  const configured = Object.values(firebase).every((v) => v.length > 0);
  return {
    apiBaseUrl: e.VITE_API_BASE_URL.replace(/\/+$/, ''),
    firebase: configured ? firebase : null,
    authEmulatorUrl: e.VITE_FIREBASE_AUTH_EMULATOR_URL || null,
    useMock: isDev && e.VITE_USE_MOCK_API === 'true',
  };
}

export const config: AppConfig = parseConfig(import.meta.env as Record<string, unknown>, import.meta.env.DEV);
