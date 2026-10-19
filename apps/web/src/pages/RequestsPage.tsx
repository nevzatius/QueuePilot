import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DISPLAY_STATUSES, deriveDisplayStatus, type DisplayStatus, type RequestSummary } from '@queuepilot/contracts';
import { useApi } from '../api/ApiContext';
import { ApiError } from '../api/client';
import { useSession } from '../auth/SessionContext';
import { EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge, buttonClass } from '../components/ui';
import { t, tDynamic } from '../i18n';
import { formatDateTime } from '../lib/format';
import { useResource } from '../lib/useResource';

export const POLL_INTERVAL_MS = 5000;
const PAGE_SIZE = 20;

export function RequestsPage() {
  const api = useApi();
  const { isAdmin, handleApiError } = useSession();
  const [params, setParams] = useSearchParams();
  // Members can never reach the tenant scope, whatever the URL says.
  const scope = isAdmin && params.get('scope') === 'tenant' ? 'tenant' : 'mine';
  const [filter, setFilter] = useState<DisplayStatus | 'ALL'>('ALL');

  const first = useResource(() => api.listRequests({ scope, limit: PAGE_SIZE }), [api, scope], {
    intervalMs: POLL_INTERVAL_MS,
  });

  const [extra, setExtra] = useState<{ items: RequestSummary[]; nextCursor: string | null } | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<ApiError | null>(null);
  useEffect(() => {
    setExtra(null);
    setMoreError(null);
  }, [scope]);

  const nextCursor = extra ? extra.nextCursor : (first.data?.nextCursor ?? null);
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setMoreLoading(true);
    setMoreError(null);
    try {
      const page = await api.listRequests({ scope, limit: PAGE_SIZE, cursor: nextCursor });
      setExtra((prev) => ({ items: [...(prev?.items ?? []), ...page.items], nextCursor: page.nextCursor }));
    } catch (e) {
      handleApiError(e);
      setMoreError(e instanceof ApiError ? e : new ApiError('unexpected', null, null, 'Unexpected error'));
    } finally {
      setMoreLoading(false);
    }
  }, [api, scope, nextCursor, handleApiError]);

  const items = useMemo(() => {
    const head = first.data?.items ?? [];
    const seen = new Set(head.map((i) => i.requestId));
    return [...head, ...(extra?.items ?? []).filter((i) => !seen.has(i.requestId))];
  }, [first.data, extra]);

  const rows = items
    .map((item) => ({ item, display: deriveDisplayStatus(item.status, item.attempts) }))
    .filter((row) => filter === 'ALL' || row.display === filter);

  const title = scope === 'tenant' ? t('list.titleTenant') : t('list.title');

  return (
    <section>
      <PageHeader
        title={title}
        actions={
          <>
            {isAdmin && (
              <button
                type="button"
                className={buttonClass('secondary')}
                onClick={() => setParams(scope === 'tenant' ? {} : { scope: 'tenant' })}
              >
                {scope === 'tenant' ? t('nav.requests') : t('nav.tenantRequests')}
              </button>
            )}
            <Link to="/requests/new" className={buttonClass()}>
              {t('nav.new')}
            </Link>
          </>
        }
      />

      {first.loading && !first.data && <Spinner />}
      {first.error && !first.data && <ErrorNotice title={t('list.error')} error={first.error} onRetry={first.reload} />}

      {first.data && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-slate-700">{t('list.filter')}</span>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as DisplayStatus | 'ALL')}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5"
              >
                <option value="ALL">{t('list.filter.all')}</option>
                {DISPLAY_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {tDynamic('status', s)}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-xs text-slate-600">{t('list.polling', { seconds: POLL_INTERVAL_MS / 1000 })}</span>
          </div>
          {first.error && (
            <div className="mb-3">
              <ErrorNotice title={t('list.error')} error={first.error} onRetry={first.reload} />
            </div>
          )}

          {items.length === 0 ? (
            <EmptyState
              title={t('list.empty.title')}
              action={
                <Link to="/requests/new" className={buttonClass()}>
                  {t('nav.new')}
                </Link>
              }
            >
              {t('list.empty.body')}
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState title={t('list.emptyFiltered')} />
          ) : (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <table className="hidden w-full text-left text-sm md:table">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th scope="col" className="px-4 py-2">{t('list.col.title')}</th>
                    <th scope="col" className="px-4 py-2">{t('list.col.type')}</th>
                    <th scope="col" className="px-4 py-2">{t('list.col.priority')}</th>
                    <th scope="col" className="px-4 py-2">{t('list.col.status')}</th>
                    <th scope="col" className="px-4 py-2">{t('list.col.created')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map(({ item, display }) => (
                    <tr key={item.requestId}>
                      <td className="px-4 py-3 font-medium">
                        <Link to={`/requests/${item.requestId}`} className="text-blue-800 underline-offset-2 hover:underline">
                          {item.title}
                        </Link>
                      </td>
                      <td className="px-4 py-3">{tDynamic('type', item.type)}</td>
                      <td className="px-4 py-3">{tDynamic('priority', item.priority)}</td>
                      <td className="px-4 py-3"><StatusBadge status={display} /></td>
                      <td className="px-4 py-3 text-slate-600">{formatDateTime(item.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="divide-y divide-slate-100 md:hidden">
                {rows.map(({ item, display }) => (
                  <li key={item.requestId} className="space-y-1 px-4 py-3">
                    <Link to={`/requests/${item.requestId}`} className="font-medium text-blue-800 hover:underline">
                      {item.title}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <StatusBadge status={display} />
                      <span>{tDynamic('type', item.type)}</span>
                      <span>· {tDynamic('priority', item.priority)}</span>
                    </div>
                    <div className="text-xs text-slate-600">{formatDateTime(item.createdAt)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {filter !== 'ALL' && <p className="mt-2 text-xs text-slate-600">{t('list.filterNote')}</p>}
          {moreError && (
            <div className="mt-3">
              <ErrorNotice error={moreError} onRetry={() => void loadMore()} />
            </div>
          )}
          {nextCursor && (
            <div className="mt-4 text-center">
              <button type="button" onClick={() => void loadMore()} disabled={moreLoading} className={buttonClass('secondary')}>
                {moreLoading ? t('common.loading') : t('common.loadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
