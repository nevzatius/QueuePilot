import { z } from 'zod';

/** Stored request status (ARCHITECTURE §6). Terminal states are absorbing (I3). */
export const REQUEST_STATUSES = ['ACCEPTED', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export const RequestStatusSchema = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export const TERMINAL_STATUSES = ['COMPLETED', 'FAILED'] as const satisfies readonly RequestStatus[];

export function isTerminalStatus(status: RequestStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

/** Why a request is FAILED. Present if and only if `status === 'FAILED'`. */
export const FAILURE_REASONS = ['ATTEMPTS_EXHAUSTED', 'PERMANENT_ERROR', 'DISPATCH_EXHAUSTED'] as const;
export const FailureReasonSchema = z.enum(FAILURE_REASONS);
export type FailureReason = z.infer<typeof FailureReasonSchema>;

/**
 * UI-only view of the stored status. `QUEUED` and `RETRYING` are derived from ACCEPTED and are never
 * stored or filtered on server-side.
 */
export const DISPLAY_STATUSES = ['QUEUED', 'RETRYING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export const DisplayStatusSchema = z.enum(DISPLAY_STATUSES);
export type DisplayStatus = z.infer<typeof DisplayStatusSchema>;

/** ACCEPTED with attempts=0 is QUEUED, ACCEPTED with attempts>0 is RETRYING (ARCHITECTURE §6). */
export function deriveDisplayStatus(status: RequestStatus, attempts: number): DisplayStatus {
  if (status === 'ACCEPTED') return attempts > 0 ? 'RETRYING' : 'QUEUED';
  return status;
}
