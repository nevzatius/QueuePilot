import { describe, expect, it } from 'vitest';
import { parseConfig } from './config';

const FIREBASE = {
  VITE_FIREBASE_API_KEY: 'k',
  VITE_FIREBASE_AUTH_DOMAIN: 'd.example.test',
  VITE_FIREBASE_PROJECT_ID: 'p',
  VITE_FIREBASE_APP_ID: 'a',
};

describe('parseConfig', () => {
  it('defaults to same-origin API and no Firebase', () => {
    expect(parseConfig({}, false)).toEqual({ apiBaseUrl: '', firebase: null, authEmulatorUrl: null, useMock: false });
  });

  it('strips trailing slashes from the API base URL', () => {
    expect(parseConfig({ VITE_API_BASE_URL: 'https://api.example.test//' }, false).apiBaseUrl).toBe('https://api.example.test');
  });

  it('requires every Firebase field', () => {
    expect(parseConfig(FIREBASE, false).firebase).toMatchObject({ projectId: 'p' });
    expect(parseConfig({ ...FIREBASE, VITE_FIREBASE_APP_ID: '' }, false).firebase).toBeNull();
  });

  it('enables the mock only in development', () => {
    expect(parseConfig({ VITE_USE_MOCK_API: 'true' }, true).useMock).toBe(true);
    expect(parseConfig({ VITE_USE_MOCK_API: 'true' }, false).useMock).toBe(false);
  });
});
