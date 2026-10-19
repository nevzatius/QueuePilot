import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { deriveDisplayStatus, isTerminalStatus, type RequestDetail } from '@queuepilot/contracts';
import { useApi } from '../api/ApiContext';
import { EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge, buttonClass } from '../components/ui';
import { t, tDynamic } from '../i18n';
import { formatDateTime, formatMinutes } from '../lib/format';
import { useResource } from '../lib/useResource';
import { POLL_INTERVAL_MS } from './RequestsPage';

export function RequestDetailPage() {
  const api = useApi();
  const { requestId = '' } = useParams();
  const { data, error, loading, reload } = useResource(() => api.getRequest(requestId), [api, requestId], {
    intervalMs: POLL_INTERVAL_MS,
    shouldPoll: (r) => !isTerminalStatus(r.status),
  });

  const back = (
    <Link to="/requests" className={buttonClass('secondary')}>
      {t('common.back')}
    </Link>
  );

  if (loading && !data) return <Spinner />;
  if (!data) {
    return (
      <section>
        <PageHeader title={t('detail.title')} actions={back} />
        {error?.code === 'NOT_FOUND' ? (
          <EmptyState title={t('detail.notFound')} />
        ) : (
          error && <ErrorNotice title={t('detail.error')} error={error} onRetry={reload} />
        )}
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <PageHeader title={data.title} actions={back} />
      {error && <ErrorNotice title={t('detail.error')} error={error} onRetry={reload} />}
      <Summary request={data} />
      {data.result && <Triage result={data.result} />}
      <Timeline request={data} />
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-base font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  );
}

function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs uppercase tracking-wide text-slate-600">{label}</dt>
          <dd className="mt-0.5 break-words text-slate-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Summary({ request: r }: { request: RequestDetail }) {
  const attributes = Object.entries(r.attributes);
  return (
    <Card title={t('detail.title')}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <StatusBadge status={deriveDisplayStatus(r.status, r.attempts)} />
        {r.statusReason && (
          <span className="text-sm text-red-900">
            {t('detail.failure')}: {tDynamic('reason', r.statusReason)}
          </span>
        )}
      </div>
      <Facts
        items={[
          [t('form.type'), tDynamic('type', r.type)],
          [t('form.priority'), tDynamic('priority', r.priority)],
          [t('detail.attempts'), `${r.attempts} / ${r.maxAttempts}`],
          [t('detail.duplicates'), r.duplicateDeliveries],
          [t('detail.created'), formatDateTime(r.createdAt)],
          [t('detail.updated'), formatDateTime(r.updatedAt)],
          [t('detail.started'), r.startedAt ? formatDateTime(r.startedAt) : t('common.none')],
          [t('detail.completed'), r.completedAt ? formatDateTime(r.completedAt) : t('common.none')],
          [t('detail.correlationId'), <code key="c" className="text-xs">{r.correlationId}</code>],
        ]}
      />
      <h3 className="mt-5 text-sm font-medium text-slate-800">{t('detail.description')}</h3>
      <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{r.description || t('detail.noDescription')}</p>
      {attributes.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-medium text-slate-800">{t('detail.attributes')}</h3>
          <ul className="mt-1 flex flex-wrap gap-2 text-xs">
            {attributes.map(([k, v]) => (
              <li key={k} className="rounded bg-slate-100 px-2 py-1">
                {k}: {String(v)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function Triage({ result }: { result: NonNullable<RequestDetail['result']> }) {
  return (
    <Card title={t('detail.result')}>
      <Facts
        items={[
          [t('detail.result.lane'), tDynamic('lane', result.lane)],
          [t('detail.result.sla'), formatMinutes(result.slaTargetMinutes)],
          [t('detail.result.team'), result.team],
          [t('detail.result.score'), result.score],
          [t('detail.result.rules'), result.rulesVersion],
        ]}
      />
    </Card>
  );
}

function Timeline({ request }: { request: RequestDetail }) {
  return (
    <Card title={t('detail.timeline')}>
      {request.events.length === 0 ? (
        <p className="text-sm text-slate-600">{t('detail.timeline.empty')}</p>
      ) : (
        <ol className="space-y-3 border-l border-slate-200 pl-4">
          {request.events.map((ev) => (
            <li key={`${ev.type}-${ev.seq}-${ev.attempt}-${ev.at}`} className="text-sm">
              <p className="font-medium text-slate-900">{tDynamic('event', ev.type)}</p>
              <p className="text-xs text-slate-600">
                <time dateTime={ev.at}>{formatDateTime(ev.at, true)}</time> · {tDynamic('actor', ev.actor)}
                {ev.attempt > 0 && ` · #${ev.attempt}`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
