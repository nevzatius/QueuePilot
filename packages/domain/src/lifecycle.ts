import type { Role } from '@queuepilot/contracts';
import { stableHash32 } from './fingerprint.js';
import { newIdempotencyRecord } from './idempotency.js';
import type { IdempotencyRecord } from './idempotency.js';
import { INITIAL_WATCHDOG_MS, MAX_ATTEMPTS, MAX_DISPATCH, RECONCILER_SHARDS } from './policy.js';
import { makeEvent, stateWrite } from './state.js';
import type { RequestState, StateWrite } from './state.js';
import type { EnqueueOrder } from './reconcile.js';
import type { EpochMs } from './time.js';
import { CURRENT_RULES_VERSION } from './triage/index.js';

// ---------------------------------------------------------------------------
// S1: acceptance
// ---------------------------------------------------------------------------

export interface Acceptance {
  /** S1 write: `requests/{id}` reliability fields plus the `ACCEPTED-s1` event. */
  readonly write: StateWrite;
  readonly idempotency: IdempotencyRecord;
  readonly watchdogShard: number;
  /** Pinned at acceptance; reprocessing always uses this version (I6). */
  readonly rulesVersion: string;
  /** The API's best-effort `createTask` after the commit. Failures are only logged (ARCHITECTURE §4). */
  readonly enqueue: { readonly seq: 1 };
}

/**
 * Reconciler shard for a request. `requestId` is a random UUIDv4, so the shard is uniformly spread
 * while staying reproducible from the ID.
 */
export function watchdogShardFor(requestId: string): number {
  return stableHash32(requestId) % RECONCILER_SHARDS;
}

/** S1: the content of the atomic acceptance batch, once `decideIdempotency` returned CREATE or TAKEOVER. */
export function planAcceptance(input: { requestId: string; payloadFingerprint: string; now: EpochMs }): Acceptance {
  const { requestId, payloadFingerprint, now } = input;
  const state: RequestState = {
    status: 'ACCEPTED',
    statusReason: null,
    processing: { attempts: 0, maxAttempts: MAX_ATTEMPTS, lease: null, lastError: null, duplicateDeliveries: 0 },
    dispatch: { seq: 1, deliveredSeq: 0, checks: 0, maxSeq: MAX_DISPATCH, lastError: null },
    watchdogAt: now + INITIAL_WATCHDOG_MS,
    startedAt: null,
    completedAt: null,
  };
  return {
    write: stateWrite('S1', null, state, [makeEvent('ACCEPTED', 'api', state, now)]),
    idempotency: newIdempotencyRecord(requestId, payloadFingerprint, now),
    watchdogShard: watchdogShardFor(requestId),
    rulesVersion: CURRENT_RULES_VERSION,
    enqueue: { seq: 1 },
  };
}

// ---------------------------------------------------------------------------
// S12 (P1): admin retry
// ---------------------------------------------------------------------------

export type AdminRetryDecision =
  | { readonly kind: 'FORBIDDEN'; readonly write: null }
  | { readonly kind: 'NOT_FOUND'; readonly write: null }
  /** Only FAILED requests can be retried; COMPLETED stays absorbing. */
  | { readonly kind: 'NOT_RETRYABLE'; readonly write: null }
  /**
   * Commit `write`, then `createTask` for `enqueue.seq` and continue with step 3 of the reconciler flow
   * (`decideEnqueueResult`, then `decideVerifyResult` on ALREADY_EXISTS).
   */
  | { readonly kind: 'RETRY'; readonly enqueue: EnqueueOrder; readonly write: StateWrite };

/**
 * S12 (P1, **not an MVP feature**): FAILED → ACCEPTED with a fresh retry budget epoch. No MVP route or
 * adapter calls this; wiring it needs owner approval of P1 and an ADR for its I3 and I7 exceptions (see
 * "Budgets and counters" in `state.ts`). `role` must come from an **uncached** membership read
 * (ADR-010). Counters stay monotonic: the ceilings are raised instead of resetting `attempts` or `seq`,
 * so deterministic event IDs never collide and I5 holds per epoch. `startedAt`, `deliveredSeq` and both
 * `lastError` fields are kept as history.
 */
export function decideAdminRetry(state: RequestState | null, role: Role, now: EpochMs): AdminRetryDecision {
  if (role !== 'admin') return { kind: 'FORBIDDEN', write: null };
  if (state === null) return { kind: 'NOT_FOUND', write: null };
  if (state.status !== 'FAILED') return { kind: 'NOT_RETRYABLE', write: null };

  const seq = state.dispatch.seq + 1;
  const claim = now + INITIAL_WATCHDOG_MS;
  const next: RequestState = {
    ...state,
    status: 'ACCEPTED',
    statusReason: null,
    processing: { ...state.processing, lease: null, maxAttempts: state.processing.attempts + MAX_ATTEMPTS },
    dispatch: { ...state.dispatch, seq, checks: 0, maxSeq: seq + MAX_DISPATCH - 1 },
    watchdogAt: claim,
    completedAt: null,
  };
  const event = makeEvent('REDISPATCHED', 'admin', next, now, { details: { reason: 'ADMIN_RETRY' } });
  return { kind: 'RETRY', enqueue: { seq, purpose: 'REDISPATCH', claim }, write: stateWrite('S12', state, next, [event]) };
}
