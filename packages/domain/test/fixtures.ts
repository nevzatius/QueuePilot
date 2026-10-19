import { expect } from 'vitest';
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_DISPATCH,
  isAllowedTransition,
  stateViolations,
  type DispatchState,
  type ProcessingState,
  type RequestState,
  type StateWrite,
} from '../src/index.js';

/** Fixed reference instant: 2026-10-21T12:00:00Z. Tests never read the real clock. */
export const T0 = Date.UTC(2026, 9, 21, 12, 0, 0);
export const S = 1_000;
export const MIN = 60 * S;

export interface StateOverrides {
  status?: RequestState['status'];
  statusReason?: RequestState['statusReason'];
  processing?: Partial<ProcessingState>;
  dispatch?: Partial<DispatchState>;
  watchdogAt?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
}

/** A consistent ACCEPTED state, due for reconciliation at T0, with overrides applied. */
export function makeState(o: StateOverrides = {}): RequestState {
  return {
    status: o.status ?? 'ACCEPTED',
    statusReason: o.statusReason ?? null,
    processing: {
      attempts: 0,
      maxAttempts: MAX_ATTEMPTS,
      lease: null,
      lastError: null,
      duplicateDeliveries: 0,
      ...o.processing,
    },
    dispatch: { seq: 1, deliveredSeq: 0, checks: 0, maxSeq: MAX_DISPATCH, lastError: null, ...o.dispatch },
    watchdogAt: o.watchdogAt === undefined ? T0 : o.watchdogAt,
    startedAt: o.startedAt === undefined ? null : o.startedAt,
    completedAt: o.completedAt === undefined ? null : o.completedAt,
  };
}

export const accepted = (o: StateOverrides = {}): RequestState => makeState({ ...o, status: 'ACCEPTED' });

/** PROCESSING with lease `lease-1`. `leaseExpiresAt` defaults to a lease that is still valid at T0. */
export function processing(
  o: StateOverrides & { leaseId?: string; leaseExpiresAt?: number } = {},
): RequestState {
  const attempts = o.processing?.attempts ?? 1;
  const expiresAt = o.leaseExpiresAt ?? T0 + LEASE_MS / 2;
  return makeState({
    startedAt: T0 - MIN,
    ...o,
    status: 'PROCESSING',
    processing: { ...o.processing, attempts, lease: { id: o.leaseId ?? 'lease-1', expiresAt } },
    dispatch: { deliveredSeq: o.dispatch?.seq ?? 1, ...o.dispatch },
    watchdogAt: o.watchdogAt === undefined ? expiresAt + 30 * S : o.watchdogAt,
  });
}

export const completed = (o: StateOverrides = {}): RequestState =>
  makeState({
    processing: { attempts: 1 },
    dispatch: { deliveredSeq: 1 },
    startedAt: T0 - 2 * MIN,
    ...o,
    status: 'COMPLETED',
    statusReason: null,
    watchdogAt: o.watchdogAt === undefined ? null : o.watchdogAt,
    completedAt: T0 - MIN,
  });

export const failed = (reason: NonNullable<RequestState['statusReason']>, o: StateOverrides = {}): RequestState =>
  makeState({
    processing: { attempts: MAX_ATTEMPTS },
    dispatch: { deliveredSeq: 1 },
    ...o,
    status: 'FAILED',
    statusReason: reason,
    watchdogAt: o.watchdogAt === undefined ? null : o.watchdogAt,
    completedAt: T0 - MIN,
  });

/** Applies a write as the adapter would, after checking it against the transition table and invariants. */
export function apply(from: RequestState | null, write: StateWrite): RequestState {
  expect(isAllowedTransition(write.transition, from?.status ?? null, write.next.status)).toBe(true);
  expect(stateViolations(write.next)).toEqual([]);
  return write.next;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
