import type { ReactNode } from 'react';
import type { DisplayStatus } from '@queuepilot/contracts';
import type { ApiError } from '../api/client';
import { errorMessage } from '../lib/errors';
import { t, tDynamic } from '../i18n';

const STATUS_STYLES: Record<DisplayStatus, { badge: string; dot: string; glyph: string }> = {
  QUEUED: { badge: 'bg-slate-100 text-slate-800 ring-slate-300', dot: 'bg-slate-500', glyph: '○' },
  RETRYING: { badge: 'bg-amber-50 text-amber-900 ring-amber-300', dot: 'bg-amber-500', glyph: '↻' },
  PROCESSING: { badge: 'bg-blue-50 text-blue-900 ring-blue-300', dot: 'bg-blue-500', glyph: '◐' },
  COMPLETED: { badge: 'bg-green-50 text-green-900 ring-green-300', dot: 'bg-green-600', glyph: '✓' },
  FAILED: { badge: 'bg-red-50 text-red-900 ring-red-300', dot: 'bg-red-600', glyph: '✕' },
};

/** Status is conveyed by text and a glyph, never by color alone. */
export function StatusBadge({ status }: { status: DisplayStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${s.badge}`}>
      <span aria-hidden="true">{s.glyph}</span>
      {tDynamic('status', status)}
    </span>
  );
}

export function Spinner({ label = t('common.loading') }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-8 text-slate-600">
      <span
        aria-hidden="true"
        className="h-4 w-4 rounded-full border-2 border-slate-300 border-t-slate-700 motion-safe:animate-spin"
      />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {children && <p className="mt-1 text-sm text-slate-600">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorNotice({
  title,
  error,
  onRetry,
}: {
  title?: string;
  error: ApiError;
  onRetry?: () => void;
}) {
  const retryAfter = error.retryAfterSeconds;
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900">
      {title && <p className="font-semibold">{title}</p>}
      <p>{errorMessage(error)}</p>
      {retryAfter !== null && <p>{t('common.retryAfter', { seconds: retryAfter })}</p>}
      {error.correlationId && <p className="mt-1 text-xs text-red-800">{t('common.reference', { id: error.correlationId })}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry} className={`${buttonClass('secondary')} mt-3`}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function buttonClass(variant: 'primary' | 'secondary' = 'primary'): string {
  const base =
    'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:cursor-not-allowed disabled:opacity-60';
  return variant === 'primary'
    ? `${base} bg-slate-900 text-white hover:bg-slate-700`
    : `${base} border border-slate-300 bg-white text-slate-900 hover:bg-slate-50`;
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
