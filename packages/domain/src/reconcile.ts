import { ATTENTION_REDISPATCH_MS, LEASE_GRACE_MS, PROBE_BACKOFF_CAP_MS, RETRY_WATCHDOG_MS } from './policy.js';
import {
  failedEvent,
  failedState,
  isAttemptBudgetExhausted,
  isDispatchBudgetExhausted,
  isLeaseValid,
  isTerminal,
  makeEvent,
  stateWrite,
} from './state.js';
import type { ErrorInfo, RequestState, StateWrite } from './state.js';
import { MINUTE_MS } from './time.js';
import type { EpochMs } from './time.js';

/**
 * Reconciler decisions (ARCHITECTURE §6, ADR-017; supersedes the probe-and-verify flow of ADR-014).
 *
 * A Cloud Tasks task is only a wake-up call for the worker. Firestore alone decides whether business logic
 * runs: the lease (I4), the attempt budget (I5) and terminal absorption (I3). Any task of a runnable request
 * may process it, whatever its `seq`, and every extra task is absorbed. The reconciler therefore never has to
 * prove that a task is gone. When a request is due and no task is observed, it places a new dispatch order.
 *
 * Dispatch orders. DISPATCH increments `dispatch.seq` and moves the watchdog in one transaction, before any
 * `createTask`. The task name is `r-{id}-{seq}`, so every name has exactly one creator: the API for seq 1
 * (after S1) and the committer of seq n for n >= 2. Hence:
 * - Two reconcilers never share a name. A stalled one can only add a late, harmless extra task.
 * - ALREADY_EXISTS can only answer the creator's own earlier call, so it counts as CREATED.
 * - No decision depends on GetTask, ALREADY_EXISTS, tombstones or how long they last.
 * The committed order (`seq` and `watchdogAt`) is the durable dispatch intent. If `createTask` never runs or
 * fails, the watchdog fires and the next pass places a new order.
 *
 * Adapter flow for one due request. Crashing or stalling at any point is safe.
 * 1. `decideReconcile(state, null, now)` on a plain read. Unless it returns PROBE_TASK, re-run it inside a
 *    transaction and commit its `write`.
 * 2. PROBE_TASK: `getTask(r-{id}-{seq})`, mapped to EXISTS | NOT_FOUND | UNKNOWN (every error except
 *    NOT_FOUND is UNKNOWN). Then, in a transaction: `decideReconcile(fresh, probe, now)`, commit `write`.
 *    The probe is a load hint, not evidence. An adapter that skips it passes UNKNOWN.
 * 3. DISPATCH: after the commit, `createTask` for `enqueue.seq`. Retrying the same name within the pass is
 *    fine. Then, in a transaction: `decideEnqueueResult(fresh, enqueue, outcome, now)`, which records
 *    diagnostics only.
 *
 * Bounds and backpressure.
 * - EXISTS never places an order, so a backlog does not multiply tasks.
 * - Orders with `seq <= maxSeq` are prompt (S9, watchdog +5 min). Later orders are attention orders (S10):
 *   the request stays non-terminal, `dispatch.attentionSince` is set, and orders continue at most every
 *   30 min until a delivery clears it. Without a lease in between, consecutive orders are at least 5 min
 *   apart, or 30 min apart once in attention.
 * - A failed `createTask` creates no task, so a queue outage costs orders but no tasks. Recovery after the
 *   outage takes at most one attention interval.
 */

export type ProbeResult = 'EXISTS' | 'NOT_FOUND' | 'UNKNOWN';

export interface TaskProbe {
  /** The `seq` whose task name was probed. A probe for another order is ignored. */
  readonly seq: number;
  readonly result: ProbeResult;
  /** Raw error code for UNKNOWN, for logs only. */
  readonly errorCode?: string;
}

/** Instruction to call `createTask` for `r-{id}-{seq}`, whose `seq` the caller has just committed. */
export interface EnqueueOrder {
  readonly seq: number;
}

export type ReconcileDecision =
  | { readonly kind: 'NOOP'; readonly reason: 'NO_DOCUMENT' | 'NOT_DUE' | 'ALREADY_CLEAN'; readonly write: null }
  /** Step 1: terminal request with a leftover watchdog. */
  | { readonly kind: 'CLEAR_WATCHDOG'; readonly write: StateWrite }
  /** Step 2: a worker holds a valid lease. */
  | { readonly kind: 'WAIT_FOR_LEASE'; readonly write: StateWrite }
  /** Step 3 (S8): the attempt budget is spent by business-logic starts. The only reconciler failure. */
  | { readonly kind: 'FAIL'; readonly reason: 'ATTEMPTS_EXHAUSTED'; readonly write: StateWrite }
  /** Step 4 needs the optional `getTask` hint for `seq`. */
  | { readonly kind: 'PROBE_TASK'; readonly seq: number; readonly write: null }
  /** The probe refers to an older order: someone placed a newer one since. Do nothing. */
  | { readonly kind: 'PROBE_STALE'; readonly write: null }
  /** Step 4: the latest task exists (queued, backlogged or retrying). Back off; place no order. */
  | { readonly kind: 'WAIT_FOR_TASK'; readonly write: StateWrite }
  /**
   * Step 5: no task observed (NOT_FOUND or UNKNOWN). `seq` incremented; create `enqueue.seq`. S9 while
   * `seq <= maxSeq` after the increment, otherwise S10 (`attention`). Never terminal.
   */
  | { readonly kind: 'DISPATCH'; readonly enqueue: EnqueueOrder; readonly attention: boolean; readonly write: StateWrite };

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

  if (isLeaseValid(state, now) && state.processing.lease !== null) {
    const next: RequestState = { ...state, watchdogAt: state.processing.lease.expiresAt + LEASE_GRACE_MS };
    return { kind: 'WAIT_FOR_LEASE', write: stateWrite('WATCHDOG', state, next) };
  }
  if (isAttemptBudgetExhausted(state)) {
    const write = stateWrite('S8', state, failedState(state, 'ATTEMPTS_EXHAUSTED', now), [
      failedEvent(state, 'ATTEMPTS_EXHAUSTED', 'reconciler', now),
    ]);
    return { kind: 'FAIL', reason: 'ATTEMPTS_EXHAUSTED', write };
  }

  if (probe === null) return { kind: 'PROBE_TASK', seq: state.dispatch.seq, write: null };
  if (probe.seq !== state.dispatch.seq) return { kind: 'PROBE_STALE', write: null };
  if (probe.result === 'EXISTS') return { kind: 'WAIT_FOR_TASK', write: waitForTask(state, now) };
  return dispatch(state, probe.result, now);
}

// ---------------------------------------------------------------------------
// decideEnqueueResult
// ---------------------------------------------------------------------------

export type EnqueueOutcome =
  | { readonly result: 'CREATED' }
  /** The order's own earlier call created the name (every name has one creator). Same as CREATED. */
  | { readonly result: 'ALREADY_EXISTS' }
  /** No task was created, or the outcome is unknown. Either way the next order covers it. */
  | { readonly result: 'FAILED'; readonly error: { readonly code: string; readonly message: string } };

export type EnqueueDecision =
  | {
      readonly kind: 'NOOP';
      /** `SUPERSEDED`: a newer order exists. `UNCHANGED`: nothing to record. */
      readonly reason: 'NO_DOCUMENT' | 'TERMINAL' | 'SUPERSEDED' | 'UNCHANGED';
      readonly write: null;
    }
  /** Only `dispatch.lastError` changes. Status, `seq`, watchdog and budgets never do. */
  | { readonly kind: 'RECORDED'; readonly write: StateWrite };

/**
 * Records a `createTask` outcome for operators, inside a transaction on a fresh read. It only writes
 * `dispatch.lastError`, so it cannot race with anything: scheduling was settled when the order committed.
 */
export function decideEnqueueResult(
  state: RequestState | null,
  order: EnqueueOrder,
  outcome: EnqueueOutcome,
  now: EpochMs,
): EnqueueDecision {
  if (state === null) return { kind: 'NOOP', reason: 'NO_DOCUMENT', write: null };
  if (isTerminal(state)) return { kind: 'NOOP', reason: 'TERMINAL', write: null };
  if (state.dispatch.seq !== order.seq) return { kind: 'NOOP', reason: 'SUPERSEDED', write: null };

  const lastError: ErrorInfo | null =
    outcome.result === 'FAILED' ? { code: outcome.error.code, message: outcome.error.message, at: now } : null;
  if (lastError === null && state.dispatch.lastError === null) return { kind: 'NOOP', reason: 'UNCHANGED', write: null };
  const next: RequestState = { ...state, dispatch: { ...state.dispatch, lastError } };
  return { kind: 'RECORDED', write: stateWrite('WATCHDOG', state, next) };
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

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

/**
 * Step 5: a new order with a fresh name. The first order past `maxSeq` sets `attentionSince` and records a
 * REDISPATCHED event; later attention orders stay silent so the timeline does not grow every 30 minutes.
 */
function dispatch(
  state: RequestState,
  cause: Exclude<ProbeResult, 'EXISTS'>,
  now: EpochMs,
): Extract<ReconcileDecision, { kind: 'DISPATCH' }> {
  const seq = state.dispatch.seq + 1;
  const attention = isDispatchBudgetExhausted(state);
  const next: RequestState = {
    ...state,
    dispatch: {
      ...state.dispatch,
      seq,
      checks: 0,
      attentionSince: attention ? (state.dispatch.attentionSince ?? now) : null,
      lastError: null,
    },
    watchdogAt: now + (attention ? ATTENTION_REDISPATCH_MS : RETRY_WATCHDOG_MS),
  };
  const events =
    state.dispatch.attentionSince === null
      ? [makeEvent('REDISPATCHED', 'reconciler', next, now, { details: { reason: `TASK_${cause}`, attention } })]
      : [];
  return { kind: 'DISPATCH', enqueue: { seq }, attention, write: stateWrite(attention ? 'S10' : 'S9', state, next, events) };
}
