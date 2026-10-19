import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface AuthUser {
  uid: string;
  email: string | null;
  displayName: string | null;
}

/** Seam between the UI and the identity provider (Firebase in production, a fake in development). */
export interface AuthAdapter {
  /** Calls back with the current user (or null) now and on every change. Returns an unsubscribe. */
  subscribe(onChange: (user: AuthUser | null) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  getIdToken(): Promise<string>;
}

/** Thrown by an adapter when the user dismisses the sign-in popup. */
export class SignInCancelledError extends Error {}

export type AuthErrorKind = 'cancelled' | 'failed';

interface AuthValue {
  status: 'loading' | 'signedOut' | 'signedIn';
  user: AuthUser | null;
  signingIn: boolean;
  error: AuthErrorKind | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ adapter, children }: { adapter: AuthAdapter; children: ReactNode }) {
  const [state, setState] = useState<{ status: AuthValue['status']; user: AuthUser | null }>({
    status: 'loading',
    user: null,
  });
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<AuthErrorKind | null>(null);

  useEffect(
    () =>
      adapter.subscribe((user) => {
        setState(user ? { status: 'signedIn', user } : { status: 'signedOut', user: null });
      }),
    [adapter],
  );

  const signIn = useCallback(async () => {
    setError(null);
    setSigningIn(true);
    try {
      await adapter.signIn();
    } catch (e) {
      setError(e instanceof SignInCancelledError ? 'cancelled' : 'failed');
    } finally {
      setSigningIn(false);
    }
  }, [adapter]);

  const signOut = useCallback(() => adapter.signOut(), [adapter]);
  const getIdToken = useCallback(() => adapter.getIdToken(), [adapter]);

  const value = useMemo<AuthValue>(
    () => ({ ...state, signingIn, error, signIn, signOut, getIdToken }),
    [state, signingIn, error, signIn, signOut, getIdToken],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
