import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  CreateRequestBodySchema,
  PrioritySchema,
  REQUEST_TYPES,
  type CreateRequestInput,
  type RequestAttributes,
  type RequestType,
} from '@queuepilot/contracts';
import { useApi } from '../api/ApiContext';
import { ApiError } from '../api/client';
import { useSession } from '../auth/SessionContext';
import { ErrorNotice, PageHeader, buttonClass } from '../components/ui';
import { t, tDynamic } from '../i18n';
import { isRetryable } from '../lib/errors';
import { createKeyManager } from '../lib/idempotency';

type FieldErrors = Partial<Record<'title' | 'description' | 'type' | 'priority' | 'attributes', string>>;

interface FormValues {
  type: RequestType;
  title: string;
  description: string;
  priority: (typeof PrioritySchema.options)[number];
  safetyRisk: '' | 'yes' | 'no';
  locationType: '' | 'highway' | 'urban' | 'rural';
  preferredWindow: '' | 'morning' | 'afternoon' | 'evening' | 'anytime';
}

const INITIAL: FormValues = {
  type: 'general',
  title: '',
  description: '',
  priority: 'normal',
  safetyRisk: '',
  locationType: '',
  preferredWindow: '',
};

export function buildPayload(v: FormValues): CreateRequestInput {
  const attributes: RequestAttributes = {};
  if (v.safetyRisk) attributes.safetyRisk = v.safetyRisk === 'yes';
  if (v.locationType) attributes.locationType = v.locationType;
  if (v.preferredWindow) attributes.preferredWindow = v.preferredWindow;
  return { type: v.type, title: v.title, description: v.description, priority: v.priority, attributes };
}

/** Maps a JSON Pointer such as `/title` or `/attributes/locationType` to a form field. */
function fieldFromPointer(pointer: string): keyof FieldErrors {
  const first = pointer.split('/')[1];
  return first === 'title' || first === 'description' || first === 'type' || first === 'priority' ? first : 'attributes';
}

type Outcome = { kind: 'idle' } | { kind: 'success'; requestId: string; replayed: boolean } | { kind: 'error'; error: ApiError };

export function NewRequestPage() {
  const api = useApi();
  const { handleApiError } = useSession();
  const keys = useRef(createKeyManager());
  const [values, setValues] = useState<FormValues>(INITIAL);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setValues((v) => ({ ...v, [key]: value }));

  const serverFieldErrors = useMemo<FieldErrors>(() => {
    if (outcome.kind !== 'error' || outcome.error.code !== 'VALIDATION_FAILED') return {};
    const out: FieldErrors = {};
    for (const issue of outcome.error.problem?.errors ?? []) out[fieldFromPointer(issue.pointer)] ??= issue.message;
    return out;
  }, [outcome]);
  const shownErrors = { ...serverFieldErrors, ...fieldErrors };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const payload = buildPayload(values);
    const parsed = CreateRequestBodySchema.safeParse(payload);
    if (!parsed.success) {
      const errs: FieldErrors = {};
      for (const issue of parsed.error.issues) errs[fieldFromPointer(`/${issue.path.join('/')}`)] ??= issue.message;
      setFieldErrors(errs);
      setOutcome({ kind: 'idle' });
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      // The key is derived from the payload, so retrying an unchanged form reuses it.
      const res = await api.createRequest(payload, keys.current.keyFor(payload));
      keys.current.reset();
      setOutcome({ kind: 'success', requestId: res.requestId, replayed: res.replayed });
    } catch (err) {
      handleApiError(err);
      setOutcome({ kind: 'error', error: err instanceof ApiError ? err : new ApiError('unexpected', null, null, 'Unexpected error') });
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setValues(INITIAL);
    setFieldErrors({});
    setOutcome({ kind: 'idle' });
  }

  if (outcome.kind === 'success') {
    return (
      <section>
        <PageHeader title={t('form.title')} />
        <div role="status" className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900">
          <p>{outcome.replayed ? t('form.replayed') : t('form.accepted')}</p>
          <div className="mt-3 flex gap-2">
            <Link to={`/requests/${outcome.requestId}`} className={buttonClass()}>
              {t('form.viewRequest')}
            </Link>
            <button type="button" onClick={reset} className={buttonClass('secondary')}>
              {t('form.another')}
            </button>
          </div>
        </div>
      </section>
    );
  }

  const inputClass =
    'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-blue-700';

  return (
    <section>
      <PageHeader title={t('form.title')} />
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="max-w-xl space-y-5 rounded-lg border border-slate-200 bg-white p-5">
        <Field id="type" label={t('form.type')} error={shownErrors.type}>
          <select id="type" className={inputClass} value={values.type} onChange={(e) => set('type', e.target.value as RequestType)}>
            {REQUEST_TYPES.map((r) => (
              <option key={r} value={r}>
                {tDynamic('type', r)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="title" label={t('form.name')} error={shownErrors.title}>
          <input
            id="title"
            className={inputClass}
            value={values.title}
            maxLength={120}
            aria-invalid={shownErrors.title ? true : undefined}
            aria-describedby={shownErrors.title ? 'title-error' : undefined}
            onChange={(e) => set('title', e.target.value)}
          />
        </Field>
        <Field id="description" label={t('form.description')} error={shownErrors.description}>
          <textarea
            id="description"
            rows={4}
            className={inputClass}
            value={values.description}
            maxLength={2000}
            aria-invalid={shownErrors.description ? true : undefined}
            aria-describedby={shownErrors.description ? 'description-error' : undefined}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
        <Field id="priority" label={t('form.priority')} error={shownErrors.priority}>
          <select
            id="priority"
            className={inputClass}
            value={values.priority}
            onChange={(e) => set('priority', e.target.value as FormValues['priority'])}
          >
            {PrioritySchema.options.map((p) => (
              <option key={p} value={p}>
                {tDynamic('priority', p)}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="space-y-4 rounded-md border border-slate-200 p-4">
          <legend className="px-1 text-sm font-medium text-slate-800">{t('form.optionalDetails')}</legend>
          <Field id="safetyRisk" label={t('form.safetyRisk')} error={shownErrors.attributes}>
            <select
              id="safetyRisk"
              className={inputClass}
              value={values.safetyRisk}
              onChange={(e) => set('safetyRisk', e.target.value as FormValues['safetyRisk'])}
            >
              <option value="">{t('form.notSet')}</option>
              <option value="yes">{t('common.yes')}</option>
              <option value="no">{t('common.no')}</option>
            </select>
          </Field>
          <Field id="locationType" label={t('form.locationType')}>
            <select
              id="locationType"
              className={inputClass}
              value={values.locationType}
              onChange={(e) => set('locationType', e.target.value as FormValues['locationType'])}
            >
              <option value="">{t('form.notSet')}</option>
              {(['highway', 'urban', 'rural'] as const).map((l) => (
                <option key={l} value={l}>
                  {tDynamic('locationType', l)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="preferredWindow" label={t('form.preferredWindow')}>
            <select
              id="preferredWindow"
              className={inputClass}
              value={values.preferredWindow}
              onChange={(e) => set('preferredWindow', e.target.value as FormValues['preferredWindow'])}
            >
              <option value="">{t('form.notSet')}</option>
              {(['morning', 'afternoon', 'evening', 'anytime'] as const).map((w) => (
                <option key={w} value={w}>
                  {tDynamic('window', w)}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>

        {outcome.kind === 'error' && (
          <div>
            <ErrorNotice title={t('form.error.generic')} error={outcome.error} />
            {isRetryable(outcome.error) && <p className="mt-2 text-xs text-slate-600">{t('form.retryHint')}</p>}
          </div>
        )}

        <button type="submit" disabled={submitting} className={buttonClass()}>
          {submitting ? t('form.submitting') : t('form.submit')}
        </button>
      </form>
    </section>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string | undefined; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
