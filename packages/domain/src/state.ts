import { isTerminalStatus } from '@queuepilot/contracts';
import type { FailureReason, RequestEvent, RequestEventType, RequestStatus } from '@queuepilot/contracts';
import { STUCK_AFTER_MS } from './policy.js';
import type { EpochMs } from './time.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface Lease {
  readonly id: string;
  readonly expiresAt: EpochMs;
}

export interface ErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly at: EpochMs;
}

/*
 * Budgets and counters.
 *
 * A retry budget epoch starts at S1 and, in P1 only, again at each admin retry (S12). The MVP has exactly
 * one epoch, so there `maxAttempts = MAX_ATTEMPTS` and `maxSeq = MAX_DISPATCH` for the whole lifetime.
 * - `processing.maxAttempts` is an absolute ceiling (I5). `dispatch.maxSeq` is the last *prompt* dispatch
 *   generation, not a ceiling: later orders are attention orders (S10), slower but never terminal.
 *   S12 raises both to `attempts + MAX_ATTEMPTS` and `newSeq + MAX_DISPATCH - 1`.
 * - `attempts`, `seq`, `deliveredSeq` and `duplicateDeliveries` never decrease, not even across S12.
 *   `checks` is a backoff counter and resets on every new lease and every new dispatch order.
 * - Event IDs are `{type}-a{attempts}` or `{type}-s{seq}`. Because the counters are monotonic, every
 *   FAILED after S12 needs a new lease (attempts++) and every REDISPATCHED a new order (seq++), so an ID is
 *   never reused after an admin retry.
 * - S12 is the only exit from a terminal status (FAILED only; COMPLETED is always absorbing, I3). It needs
 *   an ADR before it is enabled.
 */

export interface ProcessingState {
  /** Business-logic starts so far. Monotonic, also across admin retries, so `-a{n}` event IDs stay unique. */
  readonly attempts: number;
  /** Attempt budget ceiling: `attempts` may grow up to this value. MAX_ATTEMPTS at S1; only S12 raises it. */
  readonly maxAttempts: number;
  readonly lease: Lease | null;
  readonly lastError: ErrorInfo | null;
  readonly duplicateDeliveries: number;
}

export interface DispatchState {
  /**
   * Latest dispatch order; its task name is `r-{requestId}-{seq}`. Incremented once per order, in the
   * transaction that places it and before any `createTask`, so every name has exactly one creator (ADR-017).
   */
  readonly seq: number;
  /** Highest `seq` whose delivery acquired a lease. Diagnostics only; no decision depends on it. */
  readonly deliveredSeq: number;
  /** Consecutive EXISTS probes for the latest order; drives the wait backoff. */
  readonly checks: number;
  /** Last prompt dispatch generation. MAX_DISPATCH at S1; only S12 raises it. Orders past it are S10. */
  readonly maxSeq: number;
  /**
   * Set by the first attention order (S10), cleared by the next worker write or terminal transition.
   * Non-null means "prompt dispatch budget spent and no delivery since": the request needs operator
   * attention but is still recoverable. It is never a business failure.
   */
  readonly attentionSince: EpochMs | null;
  /** Last `createTask` error of the latest order, or null once it succeeded. Diagnostics only. */
  readonly lastError: ErrorInfo | null;
}

/**
 * The reliability fields of `requests/{id}` that the state machine reads and writes. `null` means
 * "field absent"; adapters translate it to a field delete. Content fields (title, result, ...) are not
 * part of the state machine.
 */
export interface RequestState {
  readonly status: RequestStatus;
  /** Present if and only if `status === 'FAILED'`. */
  readonly statusReason: FailureReason | null;
  readonly processing: ProcessingState;
  readonly dispatch: DispatchState;
  /** Present on every non-terminal request and absent on terminal ones. */
  readonly watchdogAt: EpochMs | null;
  readonly startedAt: EpochMs | null;
  readonly completedAt: EpochMs | null;
}

export function isTerminal(state: RequestState): boolean {
  return isTerminalStatus(state.status);
}

/** A lease is valid strictly before `expiresAt`; at `expiresAt` it can be taken over. */
export function isLeaseValid(state: RequestState, now: EpochMs): boolean {
  return state.status === 'PROCESSING' && state.processing.lease !== null && now < state.processing.lease.expiresAt;
}

export function attemptsRemaining(state: RequestState): number {
  return Math.max(0, state.processing.maxAttempts - state.processing.attempts);
}

export function isAttemptBudgetExhausted(state: RequestState): boolean {
  return state.processing.attempts >= state.processing.maxAttempts;
}

/** The prompt dispatch budget is spent: the next order is an attention order (S10). */
export function isDispatchBudgetExhausted(state: RequestState): boolean {
  return state.dispatch.seq >= state.dispatch.maxSeq;
}

/**
 * Prompt dispatch budget spent and no delivery since (S10). Recoverable: the reconciler keeps re-dispatching
 * at the attention cadence and any delivery clears it. Exposed to operators; never a terminal failure.
 */
export function needsAttention(state: RequestState): boolean {
  return !isTerminal(state) && state.dispatch.attentionSince !== null;
}

/** A request is stuck when its watchdog is more than 15 minutes overdue (ARCHITECTURE §7). */
export function isStuck(state: RequestState, now: EpochMs): boolean {
  return state.watchdogAt !== null && state.watchdogAt < now - STUCK_AFTER_MS;
}

/** Cloud Tasks task name for a dispatch generation (ARCHITECTURE §8). */
export function taskName(requestId: string, seq: number): string {
  return `r-${requestId}-${seq}`;
}

/**
 * Structural invariants of a stored state. Adapters may assert them at the repository boundary, and
 * tests assert them for every decision output. Returns the violated rules (empty when consistent).
 */
export function stateViolations(state: RequestState): string[] {
  const v: string[] = [];
  const { processing: p, dispatch: d } = state;
  const terminal = isTerminal(state);
  if ((state.status === 'FAILED') !== (state.statusReason !== null)) v.push('statusReason iff FAILED');
  if (terminal && state.watchdogAt !== null) v.push('terminal requests have no watchdog');
  if (!terminal && state.watchdogAt === null) v.push('non-terminal requests have a watchdog');
  if (terminal !== (state.completedAt !== null)) v.push('completedAt iff terminal');
  if (state.status !== 'PROCESSING' && p.lease !== null) v.push('lease only while PROCESSING');
  if (state.status === 'PROCESSING' && p.lease === null) v.push('PROCESSING requires a lease');
  if (!(p.attempts >= 0 && p.attempts <= p.maxAttempts)) v.push('0 <= attempts <= maxAttempts');
  if (!(d.seq >= 1 && d.maxSeq >= 1)) v.push('seq >= 1 and maxSeq >= 1');
  if (!(d.deliveredSeq >= 0 && d.deliveredSeq <= d.seq)) v.push('0 <= deliveredSeq <= seq');
  if (d.checks < 0 || p.duplicateDeliveries < 0) v.push('counters are non-negative');
  if (d.attentionSince !== null && (terminal || d.seq <= d.maxSeq)) {
    v.push('attentionSince only on non-terminal requests past maxSeq');
  }
  return v;
}

// ---------------------------------------------------------------------------
// Transitions (ARCHITECTURE §6)
// ---------------------------------------------------------------------------

/**
 * S1-S12 from the state machine table, plus `WATCHDOG`: a scheduling-only write (watchdog, checks,
 * dispatch error) that never changes `status`. S9 and S10 are dispatch orders (prompt and attention); no
 * dispatch outcome ever leads to a terminal status (ADR-017).
 */
export type TransitionId =
  | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11' | 'S12'
  | 'WATCHDOG';

interface TransitionRule {
  readonly from: readonly (RequestStatus | null)[];
  /** Allowed target statuses, or `'UNCHANGED'` when the rule must keep the status. */
  readonly to: readonly RequestStatus[] | 'UNCHANGED';
}

const NON_TERMINAL = ['ACCEPTED', 'PROCESSING'] as const;
const TERMINAL = ['COMPLETED', 'FAILED'] as const;

export const TRANSITIONS: Readonly<Record<TransitionId, TransitionRule>> = Object.freeze({
  S1: { from: [null], to: ['ACCEPTED'] },
  S2: { from: ['ACCEPTED'], to: ['PROCESSING'] },
  S3: { from: ['PROCESSING'], to: ['PROCESSING'] },
  S4: { from: ['PROCESSING'], to: ['COMPLETED'] },
  S5: { from: ['PROCESSING'], to: ['ACCEPTED'] },
  S6: { from: ['PROCESSING'], to: ['FAILED'] },
  S7: { from: ['PROCESSING'], to: ['FAILED'] },
  S8: { from: NON_TERMINAL, to: ['FAILED'] },
  S9: { from: NON_TERMINAL, to: 'UNCHANGED' },
  S10: { from: NON_TERMINAL, to: 'UNCHANGED' },
  S11: { from: TERMINAL, to: 'UNCHANGED' },
  S12: { from: ['FAILED'], to: ['ACCEPTED'] },
  WATCHDOG: { from: NON_TERMINAL, to: 'UNCHANGED' },
});

export function isAllowedTransition(id: TransitionId, from: RequestStatus | null, to: RequestStatus): boolean {
  const rule = TRANSITIONS[id];
  if (!rule.from.includes(from)) return false;
  return rule.to === 'UNCHANGED' ? from === to : rule.to.includes(to);
}

// ---------------------------------------------------------------------------
// Events and writes
// ---------------------------------------------------------------------------

export type EventActor = RequestEvent['actor'];
export type EventDetails = NonNullable<RequestEvent['details']>;

/**
 * Timeline entry. `id` is deterministic (`{type}-a{attempt}` or `{type}-s{seq}`), so retried writes are
 * idempotent creates.
 */
export interface DomainEvent {
  readonly id: string;
  readonly type: RequestEventType;
  readonly at: EpochMs;
  readonly actor: EventActor;
  readonly attempt: number;
  readonly seq: number;
  readonly details?: EventDetails;
}

/** Events that happen once per business-logic attempt; the others happen once per dispatch generation. */
const ATTEMPT_SCOPED: ReadonlySet<RequestEventType> = new Set([
  'PROCESSING_STARTED',
  'LEASE_TAKEOVER',
  'RETRY_SCHEDULED',
  'COMPLETED',
]);

export function eventId(type: RequestEventType, attempt: number, seq: number, scope?: 'attempt' | 'seq'): string {
  const byAttempt = scope === undefined ? ATTEMPT_SCOPED.has(type) : scope === 'attempt';
  return byAttempt ? `${type}-a${attempt}` : `${type}-s${seq}`;
}

export function makeEvent(
  type: RequestEventType,
  actor: EventActor,
  state: RequestState,
  at: EpochMs,
  options: { details?: EventDetails; scope?: 'attempt' | 'seq' } = {},
): DomainEvent {
  const { attempts: attempt } = state.processing;
  const { seq } = state.dispatch;
  return {
    id: eventId(type, attempt, seq, options.scope),
    type,
    at,
    actor,
    attempt,
    seq,
    ...(options.details !== undefined && { details: options.details }),
  };
}

/** A state change the adapter must commit in the same transaction that read `from`. */
export interface StateWrite {
  readonly transition: TransitionId;
  readonly next: RequestState;
  readonly events: readonly DomainEvent[];
}

export class TransitionViolation extends Error {
  constructor(id: TransitionId, from: RequestStatus | null, to: RequestStatus, details: string[] = []) {
    super(`illegal transition ${id}: ${from ?? '∅'} -> ${to}${details.length ? ` (${details.join('; ')})` : ''}`);
    this.name = 'TransitionViolation';
  }
}

/**
 * Builds a write after checking the transition table and the structural invariants. A failure is a
 * programming error in the domain, never a runtime condition, so it throws.
 */
export function stateWrite(
  transition: TransitionId,
  from: RequestState | null,
  next: RequestState,
  events: readonly DomainEvent[] = [],
): StateWrite {
  const fromStatus = from?.status ?? null;
  if (!isAllowedTransition(transition, fromStatus, next.status)) {
    throw new TransitionViolation(transition, fromStatus, next.status);
  }
  const violations = stateViolations(next);
  if (violations.length > 0) throw new TransitionViolation(transition, fromStatus, next.status, violations);
  return { transition, next, events };
}

/**
 * Failures the domain can produce. `DISPATCH_EXHAUSTED` stays in the public `FailureReason` enum for
 * compatibility, but no decision produces it any more: dispatch problems end in attention (S10, ADR-017).
 */
export type BusinessFailureReason = Exclude<FailureReason, 'DISPATCH_EXHAUSTED'>;

/** FAILED with the given reason: lease, watchdog and attention cleared, `completedAt` set. */
export function failedState(state: RequestState, reason: BusinessFailureReason, now: EpochMs): RequestState {
  return {
    ...state,
    status: 'FAILED',
    statusReason: reason,
    processing: { ...state.processing, lease: null },
    dispatch: { ...state.dispatch, attentionSince: null },
    watchdogAt: null,
    completedAt: now,
  };
}

/** Event for a FAILED transition, scoped to the attempt (`FAILED-a{attempts}`). */
export function failedEvent(
  state: RequestState,
  reason: BusinessFailureReason,
  actor: EventActor,
  now: EpochMs,
): DomainEvent {
  return makeEvent('FAILED', actor, state, now, { details: { reason }, scope: 'attempt' });
}
