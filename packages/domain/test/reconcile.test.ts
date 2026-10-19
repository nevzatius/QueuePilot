import { describe, expect, it } from 'vitest';
import {
  ATTENTION_REDISPATCH_MS,
  LEASE_GRACE_MS,
  MAX_ATTEMPTS,
  MAX_DISPATCH,
  RETRY_WATCHDOG_MS,
  decideEnqueueResult,
  decideReconcile,
  needsAttention,
  probeBackoffMs,
  type EnqueueDecision,
  type EnqueueOutcome,
  type ReconcileDecision,
  type RequestState,
  type TaskProbe,
} from '../src/index.js';
import { MIN, T0, accepted, apply, completed, deepFreeze, failed, processing } from './fixtures.js';

const probe = (result: TaskProbe['result'], seq = 1): TaskProbe => ({ seq, result });
/** Lease expired at T0 - 60s and the watchdog (lease + 30s) is due at T0. */
const expiredProcessing = (o: Parameters<typeof processing>[0] = {}) =>
  processing({ leaseExpiresAt: T0 - 60_000, watchdogAt: T0 - 30_000, ...o });
const delivered = (o: Parameters<typeof accepted>[0] = {}) =>
  accepted({ processing: { attempts: 1 }, ...o, dispatch: { deliveredSeq: o.dispatch?.seq ?? 1, ...o.dispatch } });
/** The prompt budget is spent: the latest order is the last prompt one. */
const lastPrompt = (o: Parameters<typeof accepted>[0] = {}) => accepted({ ...o, dispatch: { seq: MAX_DISPATCH, ...o.dispatch } });
/** Already in attention since T0 - 30 min. */
const inAttention = () =>
  accepted({ dispatch: { seq: MAX_DISPATCH + 1, attentionSince: T0 - ATTENTION_REDISPATCH_MS } });

describe('decideReconcile: decision table (steps 1-5, first match wins)', () => {
  const rows: Array<[string, RequestState | null, TaskProbe | null, ReconcileDecision['kind'], string | null]> = [
    ['no document', null, null, 'NOOP', null],
    ['1 terminal with watchdog', completed({ watchdogAt: T0 }), null, 'CLEAR_WATCHDOG', 'S11'],
    ['1 terminal, already clean', failed('PERMANENT_ERROR'), probe('NOT_FOUND'), 'NOOP', null],
    ['1 legacy DISPATCH_EXHAUSTED stays absorbing', failed('DISPATCH_EXHAUSTED'), probe('NOT_FOUND'), 'NOOP', null],
    ['not due: rescheduled after selection', accepted({ watchdogAt: T0 + 1 }), probe('NOT_FOUND'), 'NOOP', null],
    ['due exactly at watchdogAt', accepted({ watchdogAt: T0 }), null, 'PROBE_TASK', null],
    ['2 PROCESSING, lease valid', processing({ watchdogAt: T0 }), probe('NOT_FOUND'), 'WAIT_FOR_LEASE', 'WATCHDOG'],
    ['3 ACCEPTED, attempts = MAX', accepted({ processing: { attempts: MAX_ATTEMPTS } }), null, 'FAIL', 'S8'],
    ['3 PROCESSING expired, attempts = MAX', expiredProcessing({ processing: { attempts: MAX_ATTEMPTS } }), null, 'FAIL', 'S8'],
    ['3 beats NOT_FOUND', delivered({ processing: { attempts: MAX_ATTEMPTS } }), probe('NOT_FOUND'), 'FAIL', 'S8'],
    ['needs a probe', accepted(), null, 'PROBE_TASK', null],
    ['probe of an older order', accepted({ dispatch: { seq: 2 } }), probe('NOT_FOUND', 1), 'PROBE_STALE', null],
    ['4 EXISTS', accepted(), probe('EXISTS'), 'WAIT_FOR_TASK', 'WATCHDOG'],
    ['4 EXISTS for a delivered task', delivered(), probe('EXISTS'), 'WAIT_FOR_TASK', 'WATCHDOG'],
    ['4 EXISTS past the prompt budget', inAttention(), probe('EXISTS', MAX_DISPATCH + 1), 'WAIT_FOR_TASK', 'WATCHDOG'],
    ['5 NOT_FOUND, never delivered (S9)', accepted(), probe('NOT_FOUND'), 'DISPATCH', 'S9'],
    ['5 NOT_FOUND, delivered (S9)', delivered(), probe('NOT_FOUND'), 'DISPATCH', 'S9'],
    ['5 PROCESSING expired (S9)', expiredProcessing(), probe('NOT_FOUND'), 'DISPATCH', 'S9'],
    ['5 UNKNOWN (S9)', accepted(), probe('UNKNOWN'), 'DISPATCH', 'S9'],
    ['5 NOT_FOUND at seq = maxSeq (S10)', lastPrompt(), probe('NOT_FOUND', MAX_DISPATCH), 'DISPATCH', 'S10'],
    ['5 UNKNOWN at seq = maxSeq (S10)', lastPrompt(), probe('UNKNOWN', MAX_DISPATCH), 'DISPATCH', 'S10'],
    ['5 NOT_FOUND in attention (S10)', inAttention(), probe('NOT_FOUND', MAX_DISPATCH + 1), 'DISPATCH', 'S10'],
  ];

  it.each(rows)('%s → %s', (_name, state, p, kind, transition) => {
    const d = decideReconcile(state === null ? null : deepFreeze(state), p, T0);
    expect(d.kind).toBe(kind);
    expect(d.write?.transition ?? null).toBe(transition);
    if (state !== null && d.write !== null) apply(state, d.write);
  });
});

describe('decideReconcile: effects', () => {
  it('1: clears the watchdog of a terminal request and nothing else', () => {
    const before = completed({ watchdogAt: T0 });
    expect(decideReconcile(before, null, T0).write?.next).toEqual({ ...before, watchdogAt: null });
  });

  it('2: reschedules to lease expiry + 30 s', () => {
    const d = decideReconcile(processing({ leaseExpiresAt: T0 + 10_000, watchdogAt: T0 }), probe('NOT_FOUND'), T0);
    expect(d.write?.next.watchdogAt).toBe(T0 + 10_000 + LEASE_GRACE_MS);
  });

  it('4: EXISTS increments checks and backs off; status and seq stay unchanged (no new order)', () => {
    const before = accepted({ dispatch: { checks: 2 } });
    const d = decideReconcile(before, probe('EXISTS'), T0);
    expect(d.write?.next).toEqual({ ...before, dispatch: { ...before.dispatch, checks: 3 }, watchdogAt: T0 + 8 * MIN });
  });

  it('4: backoff is min(2^checks min, 15 min) using the incremented counter', () => {
    expect([0, 1, 2, 3, 4, 5, 50, 5000].map((c) => probeBackoffMs(c) / MIN)).toEqual([1, 2, 4, 8, 15, 15, 15, 15]);
  });

  it('5 / S9: a fresh name (seq++), checks reset, watchdog +5 min, REDISPATCHED', () => {
    const before = accepted({ dispatch: { checks: 4, lastError: { code: 'UNAVAILABLE', message: 'x', at: T0 - MIN } } });
    const d = decideReconcile(before, probe('NOT_FOUND'), T0);
    if (d.kind !== 'DISPATCH') throw new Error(d.kind);
    expect(d.enqueue).toEqual({ seq: 2 });
    expect(d.attention).toBe(false);
    expect(d.write.next).toEqual({
      ...before,
      dispatch: { ...before.dispatch, seq: 2, checks: 0, lastError: null },
      watchdogAt: T0 + RETRY_WATCHDOG_MS,
    });
    expect(d.write.events.map((e) => [e.id, e.actor, e.details])).toEqual([
      ['REDISPATCHED-s2', 'reconciler', { reason: 'TASK_NOT_FOUND', attention: false }],
    ]);
  });

  it('5 / S9: UNKNOWN is not evidence of absence, but dispatching is safe, so it dispatches', () => {
    const d = decideReconcile(accepted(), probe('UNKNOWN'), T0);
    expect(d.write?.events.map((e) => e.details)).toEqual([{ reason: 'TASK_UNKNOWN', attention: false }]);
  });

  it('5 / S10: the first order past maxSeq enters attention; the status is unchanged and never FAILED', () => {
    for (const before of [lastPrompt(), expiredProcessing({ dispatch: { seq: MAX_DISPATCH, deliveredSeq: MAX_DISPATCH } })]) {
      const d = decideReconcile(deepFreeze(before), probe('NOT_FOUND', MAX_DISPATCH), T0);
      if (d.kind !== 'DISPATCH') throw new Error(d.kind);
      const next = apply(before, d.write);
      expect(d).toMatchObject({ attention: true, enqueue: { seq: MAX_DISPATCH + 1 } });
      expect(next).toMatchObject({
        status: before.status,
        statusReason: null,
        dispatch: { seq: MAX_DISPATCH + 1, attentionSince: T0 },
        watchdogAt: T0 + ATTENTION_REDISPATCH_MS,
      });
      expect(needsAttention(next)).toBe(true);
      expect(d.write.events.map((e) => [e.id, e.details])).toEqual([
        [`REDISPATCHED-s${MAX_DISPATCH + 1}`, { reason: 'TASK_NOT_FOUND', attention: true }],
      ]);
    }
  });

  it('5 / S10: later attention orders keep attentionSince, wait 30 min and add no event', () => {
    const before = inAttention();
    const d = decideReconcile(before, probe('NOT_FOUND', MAX_DISPATCH + 1), T0);
    expect(d.write?.next.dispatch).toMatchObject({ seq: MAX_DISPATCH + 2, attentionSince: T0 - ATTENTION_REDISPATCH_MS });
    expect(d.write?.next.watchdogAt).toBe(T0 + ATTENTION_REDISPATCH_MS);
    expect(d.write?.events).toEqual([]);
  });
});

describe('decideReconcile: dispatch never fails a request', () => {
  const states: Array<[string, RequestState]> = [
    ['undelivered', accepted()],
    ['delivered', delivered()],
    ['expired lease', expiredProcessing()],
    ['last prompt order', lastPrompt()],
    ['attention', inAttention()],
  ];

  it.each(states)('%s: no probe result yields a terminal status', (_name, state) => {
    for (const result of ['EXISTS', 'NOT_FOUND', 'UNKNOWN'] as const) {
      const d = decideReconcile(deepFreeze(state), probe(result, state.dispatch.seq), T0);
      expect(d.write?.next.status, result).toBe(state.status);
    }
  });

  it('seq increments exactly on S9/S10 writes, by one', () => {
    for (const [, state] of [...states, ['lease valid', processing({ watchdogAt: T0 })] as [string, RequestState]]) {
      for (const p of [null, ...(['EXISTS', 'NOT_FOUND', 'UNKNOWN'] as const).map((r) => probe(r, state.dispatch.seq))]) {
        const d = decideReconcile(state, p, T0);
        const delta = d.write === null ? 0 : d.write.next.dispatch.seq - state.dispatch.seq;
        expect(delta).toBe(d.write?.transition === 'S9' || d.write?.transition === 'S10' ? 1 : 0);
      }
    }
  });
});

describe('decideEnqueueResult: diagnostics only', () => {
  const order = { seq: 2 };
  const ordered = (o: Parameters<typeof accepted>[0] = {}) => accepted({ ...o, dispatch: { seq: 2, ...o.dispatch } });
  const FAILED: EnqueueOutcome = { result: 'FAILED', error: { code: 'UNAVAILABLE', message: 'queue down' } };
  const rows: Array<[string, RequestState | null, EnqueueOutcome, EnqueueDecision['kind'], string | null]> = [
    ['no document', null, { result: 'CREATED' }, 'NOOP', 'NO_DOCUMENT'],
    ['terminal', completed({ dispatch: { seq: 2 } }), FAILED, 'NOOP', 'TERMINAL'],
    ['a newer order exists', accepted({ dispatch: { seq: 3 } }), FAILED, 'NOOP', 'SUPERSEDED'],
    ['CREATED, nothing to record', ordered(), { result: 'CREATED' }, 'NOOP', 'UNCHANGED'],
    ['ALREADY_EXISTS counts as CREATED', ordered(), { result: 'ALREADY_EXISTS' }, 'NOOP', 'UNCHANGED'],
    ['FAILED records the error', ordered(), FAILED, 'RECORDED', null],
    ['CREATED after a recorded error clears it', ordered({ dispatch: { lastError: { code: 'X', message: 'x', at: T0 - 1 } } }), { result: 'CREATED' }, 'RECORDED', null],
    ['a worker holds a lease: still only the error', processing({ dispatch: { seq: 2 } }), FAILED, 'RECORDED', null],
  ];

  it.each(rows)('%s → %s', (_name, state, outcome, kind, reason) => {
    const d = decideEnqueueResult(state === null ? null : deepFreeze(state), order, outcome, T0);
    expect(d.kind).toBe(kind);
    if (d.kind === 'NOOP') expect(d.reason).toBe(reason);
    if (state !== null && d.write !== null) {
      const next = apply(state, d.write);
      expect(d.write.transition).toBe('WATCHDOG');
      // Only dispatch.lastError may change: status, seq, budgets, lease and watchdog are settled.
      expect({ ...next, dispatch: { ...next.dispatch, lastError: null } }).toEqual({
        ...state,
        dispatch: { ...state.dispatch, lastError: null },
      });
      expect(d.write.events).toEqual([]);
    }
  });

  it('records the createTask error with its time', () => {
    const d = decideEnqueueResult(ordered(), order, FAILED, T0);
    expect(d.write?.next.dispatch.lastError).toEqual({ code: 'UNAVAILABLE', message: 'queue down', at: T0 });
  });
});
