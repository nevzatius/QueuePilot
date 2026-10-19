import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useMembership } from '../auth/SessionContext';
import { config } from '../config';
import { t, tDynamic } from '../i18n';
import { buttonClass } from './ui';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-blue-700 ${
    isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-200'
  }`;

export function AppShell() {
  const { user, signOut } = useAuth();
  const membership = useMembership();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:rounded focus:bg-white focus:p-2"
      >
        {t('nav.skip')}
      </a>
      {config.useMock && (
        <div className="bg-amber-200 px-4 py-1 text-center text-xs font-medium text-amber-950">{t('dev.banner')}</div>
      )}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold">{t('app.name')}</span>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{membership.tenantName}</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-slate-600 sm:inline" title={user?.email ?? undefined}>
              {user?.email ?? user?.uid} · {tDynamic('session.role', membership.role)}
            </span>
            <button type="button" onClick={() => void signOut()} className={buttonClass('secondary')}>
              {t('auth.signOut')}
            </button>
          </div>
        </div>
        <nav aria-label={t('nav.main')} className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 pb-2">
          <NavLink to="/requests" end className={linkClass}>
            {t('nav.requests')}
          </NavLink>
          <NavLink to="/requests/new" className={linkClass}>
            {t('nav.new')}
          </NavLink>
          <NavLink to="/metrics" className={linkClass}>
            {t('nav.metrics')}
          </NavLink>
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
