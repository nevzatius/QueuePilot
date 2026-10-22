import { describe, expect, it } from 'vitest';
import { parseApiBaseUrl, parseConfig } from './config';

const FIREBASE = {
  VITE_FIREBASE_API_KEY: 'k',
  VITE_FIREBASE_AUTH_DOMAIN: 'd.example.test',
  VITE_FIREBASE_PROJECT_ID: 'p',
  VITE_FIREBASE_APP_ID: 'a',
};

describe('parseConfig', () => {
  it('defaults to the dev proxy API and no Firebase', () => {
    expect(parseConfig({}, true)).toEqual({ apiBaseUrl: '', configError: null, firebase: null, authEmulatorUrl: null, useMock: false });
  });

  it('reports a missing API base URL in production only', () => {
    expect(parseConfig({}, false)).toMatchObject({ apiBaseUrl: '', configError: 'missing' });
    expect(parseConfig({ VITE_API_BASE_URL: '   ' }, false).configError).toBe('missing');
    expect(parseConfig({}, true).configError).toBeNull();
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

describe('parseApiBaseUrl', () => {
  const prod = (raw: string) => parseApiBaseUrl(raw, false);

  it('strips trailing slashes so joining a path never doubles one', () => {
    expect(prod('https://api.example.test/')).toEqual({ url: 'https://api.example.test', problem: null });
    expect(prod('https://api.example.test///')).toEqual({ url: 'https://api.example.test', problem: null });
    expect(prod(' https://api.example.test/base/ ')).toEqual({ url: 'https://api.example.test/base', problem: null });
  });

  it('rejects http in production but allows it in development', () => {
    expect(prod('http://api.example.test')).toEqual({ url: '', problem: 'insecure' });
    expect(parseApiBaseUrl('http://localhost:8080/', true)).toEqual({ url: 'http://localhost:8080', problem: null });
  });

  it('rejects values that are not a plain absolute http(s) URL', () => {
    for (const raw of ['api.example.test', '/api', 'ftp://api.example.test', 'https://u:p@api.example.test', 'https://api.example.test/?a=1', 'https://api.example.test/#x']) {
      expect(prod(raw).problem, raw).toBe('invalid');
    }
  });
});
