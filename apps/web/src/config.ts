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

/** Why the API base URL is unusable. Shown by the startup configuration error page. */
export type ApiBaseUrlProblem = 'missing' | 'invalid' | 'insecure';

export interface AppConfig {
  /** Base URL of the API without a trailing slash. Empty only in development (Vite dev proxy). */
  apiBaseUrl: string;
  /** Set when the API base URL cannot be used; the app then renders a configuration error instead of starting. */
  configError: ApiBaseUrlProblem | null;
  firebase: { apiKey: string; authDomain: string; projectId: string; appId: string } | null;
  authEmulatorUrl: string | null;
  /** Development-only mock API and fake sign-in. Never true in a production build. */
  useMock: boolean;
}

/**
 * Production needs an absolute https URL (the web app and the API are on different origins). Development also accepts
 * http, and an empty value that falls back to the dev proxy. The result never ends in a slash, and has no query or hash.
 */
export function parseApiBaseUrl(raw: string, isDev: boolean): { url: string; problem: ApiBaseUrlProblem | null } {
  const value = raw.trim();
  if (value === '') return isDev ? { url: '', problem: null } : { url: '', problem: 'missing' };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { url: '', problem: 'invalid' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { url: '', problem: 'invalid' };
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    return { url: '', problem: 'invalid' };
  }
  if (parsed.protocol === 'http:' && !isDev) return { url: '', problem: 'insecure' };
  return { url: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`, problem: null };
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
  const useMock = isDev && e.VITE_USE_MOCK_API === 'true';
  const base = parseApiBaseUrl(e.VITE_API_BASE_URL, isDev);
  return {
    apiBaseUrl: base.url,
    configError: useMock ? null : base.problem,
    firebase: configured ? firebase : null,
    authEmulatorUrl: e.VITE_FIREBASE_AUTH_EMULATOR_URL || null,
    useMock,
  };
}

export const config: AppConfig = parseConfig(import.meta.env as Record<string, unknown>, import.meta.env.DEV);
