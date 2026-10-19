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
 * Adapter flow for one due request. Every step after the first plain read runs inside a Firestore
 * transaction on a fresh read and commits the decision's `write` when it is not null.
 * 1. `decideReconcile(state, null, now)` on a plain read. Unless it says `PROBE_TASK`, re-run it inside a
 *    transaction and commit its `write`.
 * 2. On `PROBE_TASK`: `getTask(r-{id}-{seq})`, map the result to a `TaskProbe`, then
 *    `decideReconcile(fresh, probe, now)`.
 * 3. On `RECREATE_TASK` or `REDISPATCH` (after the commit): `createTask` for `enqueue.seq`, then
 *    `decideEnqueueResult(fresh, enqueue, outcome, now)`.
 * 4. On `VERIFY_TASK` (createTask answered ALREADY_EXISTS): `getTask` for the same `seq` again, then
 *    `decideVerifyResult(fresh, enqueue, probe, now)`. A `REDISPATCH` from this step returns to step 3
 *    once. That order is a fresh generation, so its own ALREADY_EXISTS ends in a wait or a recheck and
 *    never increments `seq` again: at most one increment per pass.
 *
 * Why step 4 exists: a claim fences Firestore writes, not queue side effects. A claimant that stalls past
 * its claim can still create the task after a newer claimant probed NOT_FOUND. The newer claimant's
 * ALREADY_EXISTS then means "a live task exists", not "the name is tombstoned". ALREADY_EXISTS is
 * therefore never used as evidence on its own; only a fresh NOT_FOUND after it, committed under the
 * still-current claim, proves that the generation can never run (I7).
 *
 * Abandoning the flow at any step is safe: the claim expires after `SHORT_RECHECK_MS` and the next pass
 * starts again at step 1. Claims strictly increase, because a new claimant only acts once the previous
 * claim is due (`watchdogAt <= now`) and claims `now + SHORT_RECHECK_MS`.
 *
 * Probe mapping: getTask success is EXISTS, gRPC NOT_FOUND is NOT_FOUND, and **every other error**
 * (PERMISSION_DENIED, timeouts, UNAVAILABLE, ...) is UNKNOWN. UNKNOWN never counts as absence (ADR-011).
 *
 * Queue assumptions, pending live verification (B2, C1/C2): getTask reflects a successful createTask
 * immediately, and a deleted name keeps answering ALREADY_EXISTS for some time. No decision depends on
 * how long that tombstone lasts. If it expires, the same name is simply created again.
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
 * decision; it acts as an optimistic lock so that only the claimant interprets the createTask outcome
 * and the follow-up probe.
 */
export interface EnqueueOrder {
  readonly seq: number;
  /**
   * `RECREATE`: the same name as an earlier, undelivered attempt (step 5). `REDISPATCH`: a generation
   * opened by this pass (S9 or S12), which nobody but the claimant has tried to create.
   */
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
    case 'EXISTS':
      return { kind: 'WAIT_FOR_TASK', write: waitForTask(state, now) };
    case 'UNKNOWN':
      return { kind: 'PROBE_UNKNOWN', write: recheckSoon(state, now) };
    case 'NOT_FOUND': {
      // NOT_FOUND alone does not prove the task is gone for good: it may never have been created.
      // Only a delivered generation (or a verified tombstone, see decideVerifyResult) proves loss (I7).
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
  /**
   * The name is taken. Ambiguous: a live task (possibly created late by a stalled claimant), our own
   * earlier call whose response was lost, or a tombstone of a deleted task.
   */
  | { readonly result: 'ALREADY_EXISTS' }
  | { readonly result: 'FAILED'; readonly error: { readonly code: string; readonly message: string } };

/** The claimant no longer owns the request, so nothing is written. */
export interface ClaimNoop {
  readonly kind: 'NOOP';
  readonly reason: 'NO_DOCUMENT' | 'TERMINAL' | 'STALE_SEQ' | 'CLAIM_LOST' | 'LEASE_HELD';
  readonly write: null;
}

export type EnqueueDecision =
  | ClaimNoop
  /** The task was created. Verify with a probe after the regular interval. */
  | { readonly kind: 'SCHEDULED'; readonly write: StateWrite }
  /** createTask failed: `seq` unchanged, retry the same name soon. */
  | { readonly kind: 'BACKOFF'; readonly write: StateWrite }
  /**
   * ALREADY_EXISTS proves nothing by itself. Probe `seq` again (step 4 of the adapter flow) and pass the
   * result to `decideVerifyResult` with the same order. The claim stays as it is.
   */
  | { readonly kind: 'VERIFY_TASK'; readonly seq: number; readonly write: null };

/** Interprets a `createTask` result for an `EnqueueOrder`, inside a transaction on a fresh read. */
export function decideEnqueueResult(
  state: RequestState | null,
  order: EnqueueOrder,
  outcome: EnqueueOutcome,
  now: EpochMs,
): EnqueueDecision {
  if (state === null) return claimNoop('NO_DOCUMENT');
  const lost = claimGuard(state, order, now);
  if (lost !== null) return lost;

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
    case 'ALREADY_EXISTS':
      return { kind: 'VERIFY_TASK', seq: order.seq, write: null };
  }
}

// ---------------------------------------------------------------------------
// decideVerifyResult
// ---------------------------------------------------------------------------

export type VerifyDecision =
  | ClaimNoop
  /** The name belongs to a live task. Back off exactly like step 4; never redispatch. */
  | { readonly kind: 'WAIT_FOR_TASK'; readonly write: StateWrite }
  /** Inconclusive probe (ADR-011): status and seq unchanged, re-check in 1 minute, ERROR log. */
  | { readonly kind: 'PROBE_UNKNOWN'; readonly write: StateWrite }
  /**
   * ALREADY_EXISTS then NOT_FOUND for a generation this pass opened itself (`purpose: 'REDISPATCH'`).
   * Only the claimant ever tried to create that name, so this is unexpected queue behaviour rather than
   * proof. `seq` unchanged, re-check in 1 minute, WARN log. The next pass recreates the same name and
   * proves the tombstone there if it persists.
   */
  | { readonly kind: 'RECHECK'; readonly write: StateWrite }
  /** Tombstone proven, but the attempt budget (S8) or the dispatch budget (S10) is spent. */
  | { readonly kind: 'FAIL'; readonly reason: 'ATTEMPTS_EXHAUSTED' | 'DISPATCH_EXHAUSTED'; readonly write: StateWrite }
  /** Tombstone proven (step 6, S9): `seq` incremented; return to step 3 with `enqueue`. */
  | { readonly kind: 'REDISPATCH'; readonly enqueue: EnqueueOrder; readonly write: StateWrite };

/**
 * Interprets the probe that follows an ALREADY_EXISTS, inside a transaction on a fresh read. The claim
 * and state guards come first, so a stale claimant, a delivery or a completion in the meantime ends the
 * flow without a write.
 */
export function decideVerifyResult(
  state: RequestState | null,
  order: EnqueueOrder,
  probe: TaskProbe,
  now: EpochMs,
): VerifyDecision {
  if (state === null) return claimNoop('NO_DOCUMENT');
  if (probe.seq !== order.seq) return claimNoop('STALE_SEQ');
  const lost = claimGuard(state, order, now);
  if (lost !== null) return lost;

  switch (probe.result) {
    case 'EXISTS':
      return { kind: 'WAIT_FOR_TASK', write: waitForTask(state, now) };
    case 'UNKNOWN':
      return { kind: 'PROBE_UNKNOWN', write: recheckSoon(state, now) };
    case 'NOT_FOUND': {
      if (order.purpose === 'REDISPATCH') return { kind: 'RECHECK', write: recheckSoon(state, now) };
      // The name is taken, no task holds it, and our claim is still current: the name is tombstoned and
      // this generation can never run again. Absence is proven.
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

function claimNoop(reason: ClaimNoop['reason']): ClaimNoop {
  return { kind: 'NOOP', reason, write: null };
}

/** Current-claim and state guards for every decision that follows a queue side effect. */
function claimGuard(state: RequestState, order: EnqueueOrder, now: EpochMs): ClaimNoop | null {
  if (isTerminal(state)) return claimNoop('TERMINAL');
  if (state.dispatch.seq !== order.seq) return claimNoop('STALE_SEQ');
  // Someone else (a worker, another reconciler) touched the request since the claim; they own it now.
  if (state.watchdogAt !== order.claim) return claimNoop('CLAIM_LOST');
  if (isLeaseValid(state, now)) return claimNoop('LEASE_HELD');
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

/** Step 4: checks++, watchdog = now + min(2^checks min, 15 min). Status and seq unchanged. */
function waitForTask(state: RequestState, now: EpochMs): StateWrite {
  const checks = state.dispatch.checks + 1;
  const next: RequestState = {
    ...state,
    dispatch: { ...state.dispatch, checks },
    watchdogAt: now + probeBackoffMs(checks),
  };
  return stateWrite('WATCHDOG', state, next);
}

/** Only the watchdog moves, to now + 1 minute. */
function recheckSoon(state: RequestState, now: EpochMs): StateWrite {
  return stateWrite('WATCHDOG', state, { ...state, watchdogAt: now + SHORT_RECHECK_MS });
}

function scheduled(state: RequestState, now: EpochMs): Extract<EnqueueDecision, { kind: 'SCHEDULED' }> {
  const next: RequestState = {
    ...state,
    dispatch: { ...state.dispatch, lastError: null },
    watchdogAt: now + RETRY_WATCHDOG_MS,
  };
  return { kind: 'SCHEDULED', write: stateWrite('WATCHDOG', state, next) };
}
