import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Membership } from '@queuepilot/contracts';
import { ApiError } from '../api/client';
import { useApi } from '../api/ApiContext';

export type SessionState =
  | { kind: 'loading' }
  | { kind: 'error'; error: ApiError }
  | { kind: 'onboarding' }
  | { kind: 'blocked'; reason: 'membership' | 'tenant' }
  | { kind: 'ready'; membership: Membership };

interface SessionValue {
  state: SessionState;
  joining: boolean;
  joinError: ApiError | null;
  isAdmin: boolean;
  reload: () => void;
  join: () => Promise<void>;
  /** Pages report API failures so the session can react to membership changes (§11). */
  handleApiError: (error: unknown) => void;
}

const SessionContext = createContext<SessionValue | null>(null);

const SESSION_CODES = new Set(['ONBOARDING_REQUIRED', 'MEMBERSHIP_SUSPENDED', 'TENANT_SUSPENDED']);

function stateFromMembership(membership: Membership | null): SessionState {
  if (!membership) return { kind: 'onboarding' };
  if (membership.status === 'suspended') return { kind: 'blocked', reason: 'membership' };
  if (membership.tenantStatus === 'suspended') return { kind: 'blocked', reason: 'tenant' };
  return { kind: 'ready', membership };
}

function toApiError(e: unknown): ApiError {
  return e instanceof ApiError ? e : new ApiError('unexpected', null, null, 'Unexpected error');
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((me) => {
        if (!cancelled) setState(stateFromMembership(me.membership));
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ kind: 'error', error: toApiError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [api, nonce]);

  const reload = useCallback(() => {
    setState({ kind: 'loading' });
    setNonce((n) => n + 1);
  }, []);

  const join = useCallback(async () => {
    setJoining(true);
    setJoinError(null);
    try {
      const res = await api.bootstrap();
      setState(stateFromMembership(res.membership));
    } catch (e) {
      setJoinError(toApiError(e));
    } finally {
      setJoining(false);
    }
  }, [api]);

  const handleApiError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.code && SESSION_CODES.has(error.code)) reload();
    },
    [reload],
  );

  const value = useMemo<SessionValue>(
    () => ({
      state,
      joining,
      joinError,
      isAdmin: state.kind === 'ready' && state.membership.role === 'admin',
      reload,
      join,
      handleApiError,
    }),
    [state, joining, joinError, reload, join, handleApiError],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

/** Membership of a ready session. Only call below the session gate. */
export function useMembership(): Membership {
  const { state } = useSession();
  if (state.kind !== 'ready') throw new Error('Session is not ready');
  return state.membership;
}
