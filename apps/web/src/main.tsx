import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import type { AuthAdapter } from './auth/AuthContext';
import { createFirebaseAdapter } from './auth/firebaseAdapter';
import { config } from './config';
import { ConfigErrorPage } from './pages/GatePages';
import './index.css';

/** Used when Firebase config is missing: the login page explains why sign-in is unavailable. */
const unconfiguredAdapter: AuthAdapter = {
  subscribe(onChange) {
    onChange(null);
    return () => undefined;
  },
  signIn: () => Promise.reject(new Error('Firebase is not configured')),
  signOut: () => Promise.resolve(),
  getIdToken: () => Promise.reject(new Error('Not signed in')),
};

async function start() {
  let props: Parameters<typeof App>[0];
  if (import.meta.env.DEV && config.useMock) {
    const mock = await import('./dev/mock');
    const api = mock.createMockApi({ admin: new URLSearchParams(location.search).has('mockAdmin') });
    props = { adapter: mock.createMockAuth(), createClient: () => api };
  } else {
    props = { adapter: config.firebase ? createFirebaseAdapter(config) : unconfiguredAdapter };
  }

  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root');
  createRoot(container).render(
    <StrictMode>
      {config.configError ? (
        <ConfigErrorPage problem={config.configError} />
      ) : (
        <BrowserRouter>
          <App {...props} />
        </BrowserRouter>
      )}
    </StrictMode>,
  );
}

void start();
