import { useApi } from '../api/ApiContext';
import { EmptyState, ErrorNotice, PageHeader, Spinner, buttonClass } from '../components/ui';
import { t, tDynamic } from '../i18n';
import { formatDateTime } from '../lib/format';
import { useResource } from '../lib/useResource';
import { POLL_INTERVAL_MS } from './RequestsPage';

const ORDER = ['ACCEPTED', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;

export function MetricsPage() {
  const api = useApi();
  const { data, error, loading, reload } = useResource(() => api.getMetrics(), [api], { intervalMs: POLL_INTERVAL_MS });

  const total = data ? ORDER.reduce((sum, k) => sum + data.counts[k], 0) : 0;

  return (
    <section>
      <PageHeader
        title={t('metrics.title')}
        actions={
          <button type="button" onClick={reload} className={buttonClass('secondary')}>
            {t('common.refresh')}
          </button>
        }
      />
      <p className="mb-4 text-sm text-slate-600">{t('metrics.intro')}</p>

      {loading && !data && <Spinner />}
      {error && <ErrorNotice title={t('metrics.error')} error={error} onRetry={reload} />}

      {data &&
        (total === 0 && data.stuck === 0 ? (
          <EmptyState title={t('metrics.empty')} />
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {ORDER.map((k) => (
                <li key={k} className="rounded-lg border border-slate-200 bg-white p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-600">{tDynamic('status', k)}</p>
                  <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{data.counts[k]}</p>
                </li>
              ))}
              <li className={`rounded-lg border p-4 ${data.stuck > 0 ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'}`}>
                <p className="text-xs uppercase tracking-wide text-slate-600">{t('metrics.stuck')}</p>
                <p className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{data.stuck}</p>
                <p className="mt-1 text-xs text-slate-600">{t('metrics.stuckHelp')}</p>
              </li>
            </ul>
            <p className="mt-3 text-xs text-slate-600">
              {t('metrics.generated', { time: formatDateTime(data.generatedAt, true), source: data.source })}
            </p>
          </>
        ))}
    </section>
  );
}
