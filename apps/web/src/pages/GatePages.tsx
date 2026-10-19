import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useSession } from '../auth/SessionContext';
import { config } from '../config';
import { t } from '../i18n';
import { ErrorNotice, Spinner, buttonClass } from '../components/ui';

function Centered({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-medium text-slate-600">{t('app.name')}</p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">{title}</h1>
        <div className="mt-4 space-y-4 text-sm text-slate-700">{children}</div>
      </div>
    </main>
  );
}

export function LoadingScreen({ label }: { label?: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50">
      <Spinner {...(label !== undefined && { label })} />
    </main>
  );
}

export function LoginPage() {
  const { signIn, signingIn, error } = useAuth();
  return (
    <Centered title={t('auth.title')}>
      <p>{t('auth.intro')}</p>
      {!config.useMock && !config.firebase && <p role="alert" className="text-red-800">{t('auth.configMissing')}</p>}
      {error && (
        <p role="alert" className="text-red-800">
          {error === 'cancelled' ? t('auth.cancelled') : t('auth.failed')}
        </p>
      )}
      <button type="button" onClick={() => void signIn()} disabled={signingIn} className={`${buttonClass()} w-full`}>
        {signingIn ? t('auth.signingIn') : t('auth.signIn')}
      </button>
      {config.useMock && <p className="text-xs text-amber-800">{t('dev.banner')}</p>}
    </Centered>
  );
}

export function OnboardingPage() {
  const { join, joining, joinError } = useSession();
  const { signOut } = useAuth();
  return (
    <Centered title={t('session.onboarding.title')}>
      <p>{t('session.onboarding.body')}</p>
      {joinError && <ErrorNotice error={joinError} />}
      <div className="flex gap-2">
        <button type="button" onClick={() => void join()} disabled={joining} className={buttonClass()}>
          {joining ? t('session.onboarding.joining') : t('session.onboarding.join')}
        </button>
        <button type="button" onClick={() => void signOut()} className={buttonClass('secondary')}>
          {t('auth.signOut')}
        </button>
      </div>
    </Centered>
  );
}

export function BlockedPage({ reason }: { reason: 'membership' | 'tenant' }) {
  const { signOut } = useAuth();
  return (
    <Centered title={t(reason === 'membership' ? 'error.MEMBERSHIP_SUSPENDED' : 'error.TENANT_SUSPENDED')}>
      <p>{t(reason === 'membership' ? 'session.suspended.membership' : 'session.suspended.tenant')}</p>
      <button type="button" onClick={() => void signOut()} className={buttonClass('secondary')}>
        {t('auth.signOut')}
      </button>
    </Centered>
  );
}

export function SessionErrorPage() {
  const { state, reload } = useSession();
  const { signOut } = useAuth();
  if (state.kind !== 'error') return null;
  return (
    <Centered title={t('app.name')}>
      <ErrorNotice error={state.error} onRetry={reload} />
      <button type="button" onClick={() => void signOut()} className={buttonClass('secondary')}>
        {t('auth.signOut')}
      </button>
    </Centered>
  );
}
