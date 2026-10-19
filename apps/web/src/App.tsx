import { useMemo } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ApiProvider } from './api/ApiContext';
import { createApiClient, type ApiClient } from './api/client';
import { AuthProvider, useAuth, type AuthAdapter } from './auth/AuthContext';
import { SessionProvider, useSession } from './auth/SessionContext';
import { AppShell } from './components/AppShell';
import { config } from './config';
import {
  BlockedPage,
  LoadingScreen,
  LoginPage,
  OnboardingPage,
  SessionErrorPage,
} from './pages/GatePages';
import { MetricsPage } from './pages/MetricsPage';
import { NewRequestPage } from './pages/NewRequestPage';
import { RequestDetailPage } from './pages/RequestDetailPage';
import { RequestsPage } from './pages/RequestsPage';
import { t } from './i18n';

export interface AppProps {
  adapter: AuthAdapter;
  /** Overrides the HTTP client (dev mock, tests). */
  createClient?: (adapter: AuthAdapter) => ApiClient;
}

export function App({ adapter, createClient }: AppProps) {
  return (
    <AuthProvider adapter={adapter}>
      <AuthGate adapter={adapter} {...(createClient && { createClient })} />
    </AuthProvider>
  );
}

function AuthGate({ adapter, createClient }: AppProps) {
  const { status, user, signOut } = useAuth();
  // A new client per signed-in user, so no state leaks between accounts.
  const uid = user?.uid ?? null;
  const client = useMemo(
    () =>
      uid === null
        ? null
        : (createClient?.(adapter) ??
          createApiClient({
            baseUrl: config.apiBaseUrl,
            getToken: () => adapter.getIdToken(),
            onUnauthenticated: () => void signOut(),
          })),
    [uid, adapter, createClient],
  );

  if (status === 'loading') return <LoadingScreen />;
  if (status === 'signedOut' || !client) return <LoginPage />;
  return (
    <ApiProvider client={client}>
      <SessionProvider key={uid}>
        <SessionGate />
      </SessionProvider>
    </ApiProvider>
  );
}

function SessionGate() {
  const { state } = useSession();
  switch (state.kind) {
    case 'loading':
      return <LoadingScreen label={t('session.loading')} />;
    case 'error':
      return <SessionErrorPage />;
    case 'onboarding':
      return <OnboardingPage />;
    case 'blocked':
      return <BlockedPage reason={state.reason} />;
    case 'ready':
      return (
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/requests" element={<RequestsPage />} />
            <Route path="/requests/new" element={<NewRequestPage />} />
            <Route path="/requests/:requestId" element={<RequestDetailPage />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="*" element={<Navigate to="/requests" replace />} />
          </Route>
        </Routes>
      );
  }
}
