import { ERROR_CATALOG, problemTypeUri } from '@queuepilot/contracts';
import type { ErrorCode, ProblemDetails } from '@queuepilot/contracts';

export class ApiError extends Error {
  constructor(readonly code: ErrorCode, readonly retryAfter?: number) {
    super(ERROR_CATALOG[code].title);
  }
}

export function problemDetails(code: ErrorCode, correlationId: string): ProblemDetails {
  return { type: problemTypeUri(code), ...ERROR_CATALOG[code], code, correlationId };
}

/** Do not leak dependency errors (which may contain credentials or payloads). */
export async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('SERVICE_UNAVAILABLE', 1);
  }
}
