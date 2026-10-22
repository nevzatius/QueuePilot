import { useMemo, useState } from 'react';
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
  const [waking, setWaking] = useState(false);
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
            onWakingChange: setWaking,
          })),
    [uid, adapter, createClient],
  );

  if (status === 'loading') return <LoadingScreen />;
  if (status === 'signedOut' || !client) return <LoginPage />;
  return (
    <ApiProvider client={client}>
      {waking && <WakingNotice />}
      <SessionProvider key={uid}>
        <SessionGate />
      </SessionProvider>
    </ApiProvider>
  );
}

/** Calm, non-blocking notice while the free-tier API wakes up (see api/coldStart.ts). */
export function WakingNotice() {
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-50 border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900">
      {t('wake.notice')}
    </div>
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
