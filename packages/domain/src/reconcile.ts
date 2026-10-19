import { LEASE_GRACE_MS, PROBE_BACKOFF_CAP_MS, RETRY_WATCHDOG_MS, SHORT_RECHECK_MS } from './policy.js';
import {
  failedEvent,
  failedState,
  isAttemptBudgetExhausted,
  isCurrentTaskDelivered,
  isDispatchBudgetExhausted,
  isLeaseValid,
  isTerminal,
  makeEvent,
  stateWrite,
} from './state.js';
import type { EventDetails, RequestState, StateWrite } from './state.js';
import { MINUTE_MS } from './time.js';
import type { EpochMs } from './time.js';

/**
 * Reconciler decisions (ARCHITECTURE §6, ADR-003, ADR-011).
 *
 * Adapter flow for one due request:
 * 1. `decideReconcile(state, null, now)` on a plain read. Unless it says `PROBE_TASK`, re-run it inside a
 *    transaction on a fresh read and commit its `write`.
 * 2. On `PROBE_TASK`: `getTask(r-{id}-{seq})`, map the result to a `TaskProbe`, then re-run
 *    `decideReconcile(fresh, probe, now)` inside a transaction and commit its `write`.
 * 3. On `RECREATE_TASK` or `REDISPATCH` (after the commit): `createTask` for `enqueue.seq`, then
 *    `decideEnqueueResult(fresh, enqueue, outcome, now)` inside a transaction. A further `REDISPATCH`
 *    from that step repeats step 3 once; its own ALREADY_EXISTS never increments `seq` again.
 *
 * Probe mapping: getTask success is EXISTS, gRPC NOT_FOUND is NOT_FOUND, and **every other error**
 * (PERMISSION_DENIED, timeouts, UNAVAILABLE, ...) is UNKNOWN. UNKNOWN never counts as absence (ADR-011).
 */

export type ProbeResult = 'EXISTS' | 'NOT_FOUND' | 'UNKNOWN';

export interface TaskProbe {
  /** The `seq` whose task name was probed. A probe for another generation is ignored. */
  readonly seq: number;
  readonly result: ProbeResult;
  /** Raw error code for UNKNOWN, for logs only. */
  readonly errorCode?: string;
}

/**
 * Instruction to call `createTask` for `seq`. `claim` is the `watchdogAt` value committed with the
 * decision; it acts as an optimistic lock so that only the claimant interprets the createTask outcome.
 */
export interface EnqueueOrder {
  readonly seq: number;
  readonly purpose: 'RECREATE' | 'REDISPATCH';
  readonly claim: EpochMs;
}

export type ReconcileDecision =
  | { readonly kind: 'NOOP'; readonly reason: 'NO_DOCUMENT' | 'NOT_DUE' | 'ALREADY_CLEAN'; readonly write: null }
  /** Step 1: terminal request with a leftover watchdog. */
  | { readonly kind: 'CLEAR_WATCHDOG'; readonly write: StateWrite }
  /** Step 2: a worker holds a valid lease. */
  | { readonly kind: 'WAIT_FOR_LEASE'; readonly write: StateWrite }
  /** Step 3 (S8), or step 6 with the dispatch budget spent (S10). */
  | { readonly kind: 'FAIL'; readonly reason: 'ATTEMPTS_EXHAUSTED' | 'DISPATCH_EXHAUSTED'; readonly write: StateWrite }
  /** Steps 4-6 need `getTask` for `seq`. */
  | { readonly kind: 'PROBE_TASK'; readonly seq: number; readonly write: null }
  /** The probe refers to an older generation: the state moved on since the probe. Do nothing. */
  | { readonly kind: 'PROBE_STALE'; readonly write: null }
  /** Step 4: the task exists (queued, backlogged or retrying). Back off; never redispatch. */
  | { readonly kind: 'WAIT_FOR_TASK'; readonly write: StateWrite }
  /** Inconclusive probe (ADR-011): status and seq unchanged, re-check in 1 minute, ERROR log. */
  | { readonly kind: 'PROBE_UNKNOWN'; readonly write: StateWrite }
  /** Step 5: absent but never delivered. Recreate the **same** name; `seq` unchanged. */
  | { readonly kind: 'RECREATE_TASK'; readonly enqueue: EnqueueOrder; readonly write: StateWrite }
  /** Step 6 (S9): absence proven. `seq` incremented; create the new task. */
  | { readonly kind: 'REDISPATCH'; readonly enqueue: EnqueueOrder; readonly write: StateWrite };

/** Step-4 backoff after `checks` consecutive EXISTS probes: 2, 4, 8, then 15 minutes. */
export function probeBackoffMs(checks: number): number {
  return Math.min(2 ** Math.min(Math.max(checks, 0), 16) * MINUTE_MS, PROBE_BACKOFF_CAP_MS);
}

/** `decideReconcile(doc, probe, now)`: steps are evaluated in order; the first match wins. */
export function decideReconcile(state: RequestState | null, probe: TaskProbe | null, now: EpochMs): ReconcileDecision {
  if (state === null) return { kind: 'NOOP', reason: 'NO_DOCUMENT', write: null };

  if (isTerminal(state)) {
    if (state.watchdogAt === null) return { kind: 'NOOP', reason: 'ALREADY_CLEAN', write: null };
    return { kind: 'CLEAR_WATCHDOG', write: stateWrite('S11', state, { ...state, watchdogAt: null }) };
  }
  // Another reconciler or a worker rescheduled the request after it was selected.
  if (state.watchdogAt !== null && state.watchdogAt > now) return { kind: 'NOOP', reason: 'NOT_DUE', write: null };

  const early = leaseOrAttemptBudget(state, now);
  if (early !== null) return early;

  if (probe === null) return { kind: 'PROBE_TASK', seq: state.dispatch.seq, write: null };
  if (probe.seq !== state.dispatch.seq) return { kind: 'PROBE_STALE', write: null };

  switch (probe.result) {
    case 'EXISTS': {
      const checks = state.dispatch.checks + 1;
      const next: RequestState = {
        ...state,
        dispatch: { ...state.dispatch, checks },
        watchdogAt: now + probeBackoffMs(checks),
      };
      return { kind: 'WAIT_FOR_TASK', write: stateWrite('WATCHDOG', state, next) };
    }
    case 'UNKNOWN':
      return {
        kind: 'PROBE_UNKNOWN',
        write: stateWrite('WATCHDOG', state, { ...state, watchdogAt: now + SHORT_RECHECK_MS }),
      };
    case 'NOT_FOUND': {
      // NOT_FOUND alone does not prove the task is gone for good: it may never have been created.
      // Only a delivered generation (or a tombstone, see decideEnqueueResult) proves loss (I7).
      if (!isCurrentTaskDelivered(state)) {
        const claim = now + SHORT_RECHECK_MS;
        const write = stateWrite('WATCHDOG', state, { ...state, watchdogAt: claim });
        return { kind: 'RECREATE_TASK', enqueue: { seq: state.dispatch.seq, purpose: 'RECREATE', claim }, write };
      }
      return redispatchOrExhaust(state, now, { reason: 'DELIVERED_TASK_GONE' });
    }
  }
}

// ---------------------------------------------------------------------------
// decideEnqueueResult
// ---------------------------------------------------------------------------

export type EnqueueOutcome =
  | { readonly result: 'CREATED' }
  /** The name is taken: the task exists, or it was deleted within the dedup window (tombstone). */
  | { readonly result: 'ALREADY_EXISTS' }
  | { readonly result: 'FAILED'; readonly error: { readonly code: string; readonly message: string } };

export type EnqueueDecision =
  | {
      readonly kind: 'NOOP';
      readonly reason: 'NO_DOCUMENT' | 'TERMINAL' | 'STALE_SEQ' | 'CLAIM_LOST' | 'LEASE_HELD';
      readonly write: null;
    }
  /** The task exists. Verify with a probe after the regular interval. */
  | { readonly kind: 'SCHEDULED'; readonly write: StateWrite }
  /** createTask failed: `seq` unchanged, retry the same name soon. */
  | { readonly kind: 'BACKOFF'; readonly write: StateWrite }
  | { readonly kind: 'FAIL'; readonly reason: 'ATTEMPTS_EXHAUSTED' | 'DISPATCH_EXHAUSTED'; readonly write: StateWrite }
  /** Tombstone proven after a NOT_FOUND probe: absence is proven, so `seq` increments (step 6). */
  | { readonly kind: 'REDISPATCH'; readonly enqueue: EnqueueOrder; readonly write: StateWrite };

/** Interprets a `createTask` result for an `EnqueueOrder`, inside a transaction on a fresh read. */
export function decideEnqueueResult(
  state: RequestState | null,
  order: EnqueueOrder,
  outcome: EnqueueOutcome,
  now: EpochMs,
): EnqueueDecision {
  if (state === null) return { kind: 'NOOP', reason: 'NO_DOCUMENT', write: null };
  if (isTerminal(state)) return { kind: 'NOOP', reason: 'TERMINAL', write: null };
  if (state.dispatch.seq !== order.seq) return { kind: 'NOOP', reason: 'STALE_SEQ', write: null };
  // Someone else (a worker, another reconciler) touched the request since the claim; they own it now.
  if (state.watchdogAt !== order.claim) return { kind: 'NOOP', reason: 'CLAIM_LOST', write: null };
  if (isLeaseValid(state, now)) return { kind: 'NOOP', reason: 'LEASE_HELD', write: null };

  switch (outcome.result) {
    case 'CREATED':
      return scheduled(state, now);
    case 'FAILED': {
      const next: RequestState = {
        ...state,
        dispatch: { ...state.dispatch, lastError: { ...outcome.error, at: now } },
        watchdogAt: now + SHORT_RECHECK_MS,
      };
      return { kind: 'BACKOFF', write: stateWrite('WATCHDOG', state, next) };
    }
    case 'ALREADY_EXISTS': {
      // For a fresh generation the name may have been created by our own earlier, ambiguous call.
      // That is not proof of anything; the next probe decides.
      if (order.purpose === 'REDISPATCH') return scheduled(state, now);
      // RECREATE after NOT_FOUND under an exclusive claim: the name is tombstoned, so this generation
      // can never run again. Absence is proven.
      if (isAttemptBudgetExhausted(state)) return failAttempts(state, now);
      return redispatchOrExhaust(state, now, { reason: 'TOMBSTONE' });
    }
  }
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** Steps 2 and 3. */
function leaseOrAttemptBudget(state: RequestState, now: EpochMs): ReconcileDecision | null {
  if (isLeaseValid(state, now) && state.processing.lease !== null) {
    const next: RequestState = { ...state, watchdogAt: state.processing.lease.expiresAt + LEASE_GRACE_MS };
    return { kind: 'WAIT_FOR_LEASE', write: stateWrite('WATCHDOG', state, next) };
  }
  if (isAttemptBudgetExhausted(state)) return failAttempts(state, now);
  return null;
}

function failAttempts(state: RequestState, now: EpochMs): Extract<ReconcileDecision, { kind: 'FAIL' }> {
  const write = stateWrite('S8', state, failedState(state, 'ATTEMPTS_EXHAUSTED', now), [
    failedEvent(state, 'ATTEMPTS_EXHAUSTED', 'reconciler', now),
  ]);
  return { kind: 'FAIL', reason: 'ATTEMPTS_EXHAUSTED', write };
}

/** Step 6: S9 while dispatch budget remains, otherwise S10. Callers must have proven absence. */
function redispatchOrExhaust(
  state: RequestState,
  now: EpochMs,
  details: EventDetails,
): Extract<ReconcileDecision, { kind: 'FAIL' | 'REDISPATCH' }> {
  if (isDispatchBudgetExhausted(state)) {
    const write = stateWrite('S10', state, failedState(state, 'DISPATCH_EXHAUSTED', now), [
      failedEvent(state, 'DISPATCH_EXHAUSTED', 'reconciler', now),
    ]);
    return { kind: 'FAIL', reason: 'DISPATCH_EXHAUSTED', write };
  }
  const seq = state.dispatch.seq + 1;
  const claim = now + SHORT_RECHECK_MS;
  const next: RequestState = {
    ...state,
    dispatch: { ...state.dispatch, seq, checks: 0 },
    watchdogAt: claim,
  };
  const event = makeEvent('REDISPATCHED', 'reconciler', next, now, { details });
  return { kind: 'REDISPATCH', enqueue: { seq, purpose: 'REDISPATCH', claim }, write: stateWrite('S9', state, next, [event]) };
}

function scheduled(state: RequestState, now: EpochMs): Extract<EnqueueDecision, { kind: 'SCHEDULED' }> {
  const next: RequestState = {
    ...state,
    dispatch: { ...state.dispatch, lastError: null },
    watchdogAt: now + RETRY_WATCHDOG_MS,
  };
  return { kind: 'SCHEDULED', write: stateWrite('WATCHDOG', state, next) };
}
