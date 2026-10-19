import { ERROR_CATALOG, type ErrorCode } from '@queuepilot/contracts';
import { ApiError } from '../api/client';
import { t, type MessageKey } from '../i18n';

/** User-facing message for an API failure. Never shows server internals beyond the catalogued code. */
export function errorMessage(error: ApiError): string {
  if (error.kind === 'network') return t('error.network');
  if (error.code && error.code in ERROR_CATALOG) return t(`error.${error.code satisfies ErrorCode}` as MessageKey);
  return t('error.unexpected');
}

/** Codes where the request was definitively not accepted and retrying with the same key is safe. */
export function isRetryable(error: ApiError): boolean {
  if (error.kind === 'network') return true;
  const status = error.status;
  return status === 429 || (status !== null && status >= 500);
}
