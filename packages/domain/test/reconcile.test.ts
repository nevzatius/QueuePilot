import { describe, expect, it } from 'vitest';
import {
  LEASE_GRACE_MS,
  MAX_ATTEMPTS,
  MAX_DISPATCH,
  RETRY_WATCHDOG_MS,
  SHORT_RECHECK_MS,
  decideEnqueueResult,
  decideReconcile,
  decideVerifyResult,
  probeBackoffMs,
  type EnqueueDecision,
  type EnqueueOrder,
  type EnqueueOutcome,
  type ReconcileDecision,
  type RequestState,
  type TaskProbe,
  type VerifyDecision,
} from '../src/index.js';
import { MIN, T0, accepted, apply, completed, deepFreeze, failed, processing } from './fixtures.js';

const probe = (result: TaskProbe['result'], seq = 1): TaskProbe => ({ seq, result });
/** Lease expired at T0 - 60s and the watchdog (lease + 30s) is due at T0. */
const expiredProcessing = (o: Parameters<typeof processing>[0] = {}) =>
  processing({ leaseExpiresAt: T0 - 60_000, watchdogAt: T0 - 30_000, ...o });
const delivered = (o: Parameters<typeof accepted>[0] = {}) =>
  accepted({ processing: { attempts: 1 }, ...o, dispatch: { deliveredSeq: o.dispatch?.seq ?? 1, ...o.dispatch } });

describe('decideReconcile: decision table (steps 1-6, first match wins)', () => {
  const rows: Array<[string, RequestState | null, TaskProbe | null, ReconcileDecision['kind'], string | null]> = [
    ['no document', null, null, 'NOOP', null],
    ['1 terminal with watchdog', completed({ watchdogAt: T0 }), null, 'CLEAR_WATCHDOG', 'S11'],
    ['1 terminal, already clean', failed('PERMANENT_ERROR'), probe('NOT_FOUND'), 'NOOP', null],
    ['not due: rescheduled after selection', accepted({ watchdogAt: T0 + 1 }), probe('NOT_FOUND'), 'NOOP', null],
    ['due exactly at watchdogAt', accepted({ watchdogAt: T0 }), null, 'PROBE_TASK', null],
    ['2 PROCESSING, lease valid', processing({ watchdogAt: T0 }), probe('NOT_FOUND'), 'WAIT_FOR_LEASE', 'WATCHDOG'],
    ['3 ACCEPTED, attempts = MAX', accepted({ processing: { attempts: MAX_ATTEMPTS } }), null, 'FAIL', 'S8'],
    ['3 PROCESSING expired, attempts = MAX', expiredProcessing({ processing: { attempts: MAX_ATTEMPTS } }), null, 'FAIL', 'S8'],
    ['3 beats NOT_FOUND', delivered({ processing: { attempts: MAX_ATTEMPTS } }), probe('NOT_FOUND'), 'FAIL', 'S8'],
    ['needs a probe', accepted(), null, 'PROBE_TASK', null],
    ['probe of an older generation', accepted({ dispatch: { seq: 2 } }), probe('NOT_FOUND', 1), 'PROBE_STALE', null],
    ['4 EXISTS', accepted(), probe('EXISTS'), 'WAIT_FOR_TASK', 'WATCHDOG'],
    ['4 EXISTS for a delivered task', delivered(), probe('EXISTS'), 'WAIT_FOR_TASK', 'WATCHDOG'],
    ['5 NOT_FOUND, never delivered', accepted(), probe('NOT_FOUND'), 'RECREATE_TASK', 'WATCHDOG'],
    ['5 NOT_FOUND, older generation delivered', accepted({ dispatch: { seq: 2, deliveredSeq: 1 } }), probe('NOT_FOUND', 2), 'RECREATE_TASK', 'WATCHDOG'],
    ['6 NOT_FOUND, delivered, seq < MAX (S9)', delivered(), probe('NOT_FOUND'), 'REDISPATCH', 'S9'],
    ['6 PROCESSING expired, delivered (S9)', expiredProcessing(), probe('NOT_FOUND'), 'REDISPATCH', 'S9'],
    ['6 NOT_FOUND, delivered, seq = MAX (S10)', delivered({ dispatch: { seq: MAX_DISPATCH } }), probe('NOT_FOUND', MAX_DISPATCH), 'FAIL', 'S10'],
    ['probe error, undelivered', accepted(), probe('UNKNOWN'), 'PROBE_UNKNOWN', 'WATCHDOG'],
    ['probe error, delivered', delivered(), probe('UNKNOWN'), 'PROBE_UNKNOWN', 'WATCHDOG'],
    ['probe error at seq = MAX', delivered({ dispatch: { seq: MAX_DISPATCH } }), probe('UNKNOWN', MAX_DISPATCH), 'PROBE_UNKNOWN', 'WATCHDOG'],
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

  it('4: EXISTS increments checks and backs off; status and seq stay unchanged (no redispatch)', () => {
    const before = accepted({ dispatch: { checks: 2 } });
    const d = decideReconcile(before, probe('EXISTS'), T0);
    expect(d.write?.next).toEqual({ ...before, dispatch: { ...before.dispatch, checks: 3 }, watchdogAt: T0 + 8 * MIN });
  });

  it('4: backoff is min(2^checks min, 15 min) using the incremented counter', () => {
    expect([0, 1, 2, 3, 4, 5, 50, 5000].map((c) => probeBackoffMs(c) / MIN)).toEqual([1, 2, 4, 8, 15, 15, 15, 15]);
  });

  it('5: recreates the same generation and claims the request for one minute', () => {
    const before = accepted();
    const d = decideReconcile(before, probe('NOT_FOUND'), T0);
    if (d.kind !== 'RECREATE_TASK') throw new Error(d.kind);
    expect(d.enqueue).toEqual({ seq: 1, purpose: 'RECREATE', claim: T0 + SHORT_RECHECK_MS });
    expect(d.write.next).toEqual({ ...before, watchdogAt: T0 + SHORT_RECHECK_MS });
    expect(d.write.events).toEqual([]);
  });

  it('6 / S9: increments seq once, resets checks, claims and records REDISPATCHED', () => {
    const before = delivered({ dispatch: { checks: 4 } });
    const d = decideReconcile(before, probe('NOT_FOUND'), T0);
    if (d.kind !== 'REDISPATCH') throw new Error(d.kind);
    expect(d.enqueue).toEqual({ seq: 2, purpose: 'REDISPATCH', claim: T0 + SHORT_RECHECK_MS });
    expect(d.write.next).toMatchObject({ status: 'ACCEPTED', dispatch: { seq: 2, deliveredSeq: 1, checks: 0 }, processing: { attempts: 1 } });
    expect(d.write.events.map((e) => [e.id, e.details])).toEqual([['REDISPATCHED-s2', { reason: 'DELIVERED_TASK_GONE' }]]);
  });

  it('S10: fails with DISPATCH_EXHAUSTED once the dispatch budget is spent', () => {
    const d = decideReconcile(delivered({ dispatch: { seq: MAX_DISPATCH } }), probe('NOT_FOUND', MAX_DISPATCH), T0);
    expect(d.write?.next).toMatchObject({ status: 'FAILED', statusReason: 'DISPATCH_EXHAUSTED', watchdogAt: null });
    expect(d.write?.events.map((e) => e.id)).toEqual([`FAILED-s${MAX_DISPATCH}`]);
  });
});

describe('decideReconcile: probe uncertainty is conservative (ADR-011, I7)', () => {
  const states: Array<[string, RequestState]> = [
    ['undelivered', accepted()],
    ['delivered', delivered()],
    ['expired lease', expiredProcessing()],
    ['last dispatch', delivered({ dispatch: { seq: MAX_DISPATCH } })],
  ];

  it.each(states)('UNKNOWN on %s changes only the watchdog (+1 min)', (_name, state) => {
    const d = decideReconcile(deepFreeze(state), probe('UNKNOWN', state.dispatch.seq), T0);
    expect(d.kind).toBe('PROBE_UNKNOWN');
    expect(d.write?.next).toEqual({ ...state, watchdogAt: T0 + SHORT_RECHECK_MS });
  });

  it('NOT_FOUND alone never increments seq: an undelivered generation is recreated under the same name', () => {
    const d = decideReconcile(accepted({ dispatch: { seq: 2, deliveredSeq: 1 } }), probe('NOT_FOUND', 2), T0);
    expect(d.kind).toBe('RECREATE_TASK');
    expect(d.write?.next.dispatch.seq).toBe(2);
  });

  it('seq increments only on S9 writes', () => {
    const inputs: Array<[RequestState, TaskProbe | null]> = [];
    for (const state of [accepted(), delivered(), expiredProcessing(), processing({ watchdogAt: T0 }), delivered({ dispatch: { seq: 3 } })]) {
      for (const result of ['EXISTS', 'NOT_FOUND', 'UNKNOWN'] as const) inputs.push([state, probe(result, state.dispatch.seq)]);
      inputs.push([state, null]);
    }
    for (const [state, p] of inputs) {
      const d = decideReconcile(state, p, T0);
      const seqChanged = d.write !== null && d.write.next.dispatch.seq !== state.dispatch.seq;
      expect(seqChanged).toBe(d.write?.transition === 'S9');
    }
  });
});

describe('decideEnqueueResult', () => {
  const claim = T0 + SHORT_RECHECK_MS;
  const recreate: EnqueueOrder = { seq: 1, purpose: 'RECREATE', claim };
  const redispatch: EnqueueOrder = { seq: 2, purpose: 'REDISPATCH', claim };
  const claimed = (o: Parameters<typeof accepted>[0] = {}) => accepted({ watchdogAt: claim, ...o });
  const created: EnqueueOutcome = { result: 'CREATED' };
  const exists: EnqueueOutcome = { result: 'ALREADY_EXISTS' };
  const error: EnqueueOutcome = { result: 'FAILED', error: { code: 'UNAVAILABLE', message: 'try again' } };
  const now = T0 + 2_000;

  const rows: Array<[string, RequestState | null, EnqueueOrder, EnqueueOutcome, EnqueueDecision['kind'], string | null]> = [
    ['no document', null, recreate, created, 'NOOP', null],
    ['terminal', completed(), recreate, exists, 'NOOP', null],
    ['seq moved on', claimed({ dispatch: { seq: 2, deliveredSeq: 1 } }), recreate, exists, 'NOOP', null],
    ['claim lost', accepted({ watchdogAt: claim + 1 }), recreate, exists, 'NOOP', null],
    ['lease acquired meanwhile', processing({ watchdogAt: claim }), recreate, exists, 'NOOP', null],
    ['CREATED', claimed(), recreate, created, 'SCHEDULED', 'WATCHDOG'],
    ['FAILED', claimed(), recreate, error, 'BACKOFF', 'WATCHDOG'],
    ['FAILED after redispatch keeps the new seq', claimed({ dispatch: { seq: 2, deliveredSeq: 1 } }), redispatch, error, 'BACKOFF', 'WATCHDOG'],
    ['ALREADY_EXISTS on a fresh generation is verified', claimed({ dispatch: { seq: 2, deliveredSeq: 1 } }), redispatch, exists, 'VERIFY_TASK', null],
    ['ALREADY_EXISTS on recreate is verified, never a tombstone by itself', claimed(), recreate, exists, 'VERIFY_TASK', null],
    ['ALREADY_EXISTS at seq = MAX is verified, not S10', claimed({ dispatch: { seq: MAX_DISPATCH, deliveredSeq: 1 } }), { ...recreate, seq: MAX_DISPATCH }, exists, 'VERIFY_TASK', null],
    ['ALREADY_EXISTS with attempts = MAX is verified, not S8', claimed({ processing: { attempts: MAX_ATTEMPTS } }), recreate, exists, 'VERIFY_TASK', null],
  ];

  it.each(rows)('%s → %s', (_name, state, order, outcome, kind, transition) => {
    const d = decideEnqueueResult(state === null ? null : deepFreeze(state), order, outcome, now);
    expect(d.kind).toBe(kind);
    expect(d.write?.transition ?? null).toBe(transition);
    if (state !== null && d.write !== null) apply(state, d.write);
  });

  it('CREATED schedules a verification probe in 5 minutes and clears the dispatch error', () => {
    const before = claimed({ dispatch: { lastError: { code: 'X', message: 'x', at: T0 - MIN } } });
    const d = decideEnqueueResult(before, recreate, created, now);
    expect(d.write?.next).toEqual({ ...before, dispatch: { ...before.dispatch, lastError: null }, watchdogAt: now + RETRY_WATCHDOG_MS });
  });

  it('FAILED keeps seq, records the error and retries in 1 minute', () => {
    const d = decideEnqueueResult(claimed(), recreate, error, now);
    expect(d.write?.next).toMatchObject({
      dispatch: { seq: 1, lastError: { code: 'UNAVAILABLE', message: 'try again', at: now } },
      watchdogAt: now + SHORT_RECHECK_MS,
    });
  });

  it('ALREADY_EXISTS never writes and asks for a probe of the same seq', () => {
    expect(decideEnqueueResult(claimed(), recreate, exists, now)).toEqual({ kind: 'VERIFY_TASK', seq: 1, write: null });
  });
});

describe('decideVerifyResult: the probe after ALREADY_EXISTS', () => {
  const claim = T0 + SHORT_RECHECK_MS;
  const now = T0 + 3_000;
  const recreate = (seq = 1): EnqueueOrder => ({ seq, purpose: 'RECREATE', claim });
  const redispatch = (seq = 2): EnqueueOrder => ({ seq, purpose: 'REDISPATCH', claim });
  const claimed = (o: Parameters<typeof accepted>[0] = {}) => accepted({ watchdogAt: claim, ...o });
  const atMax = { dispatch: { seq: MAX_DISPATCH, deliveredSeq: MAX_DISPATCH - 1 } };
  const fresh = { dispatch: { seq: 2, deliveredSeq: 1 } };

  const rows: Array<[string, RequestState | null, EnqueueOrder, TaskProbe, VerifyDecision['kind'], string | null]> = [
    ['no document', null, recreate(), probe('NOT_FOUND'), 'NOOP', null],
    ['completed meanwhile', completed({ watchdogAt: null }), recreate(), probe('NOT_FOUND'), 'NOOP', null],
    ['seq moved on', claimed(fresh), recreate(1), probe('NOT_FOUND', 1), 'NOOP', null],
    ['probe of another seq', claimed(), recreate(1), probe('NOT_FOUND', 2), 'NOOP', null],
    ['claim lost (newer claimant)', accepted({ watchdogAt: claim + MIN }), recreate(), probe('NOT_FOUND'), 'NOOP', null],
    ['lease acquired meanwhile', processing({ watchdogAt: claim }), recreate(), probe('NOT_FOUND'), 'NOOP', null],
    ['EXISTS, seq = 1', claimed(), recreate(), probe('EXISTS'), 'WAIT_FOR_TASK', 'WATCHDOG'],
    ['EXISTS, seq = MAX', claimed(atMax), recreate(MAX_DISPATCH), probe('EXISTS', MAX_DISPATCH), 'WAIT_FOR_TASK', 'WATCHDOG'],
    ['EXISTS, fresh generation', claimed(fresh), redispatch(), probe('EXISTS', 2), 'WAIT_FOR_TASK', 'WATCHDOG'],
    ['UNKNOWN, seq = 1', claimed(), recreate(), probe('UNKNOWN'), 'PROBE_UNKNOWN', 'WATCHDOG'],
    ['UNKNOWN, seq = MAX', claimed(atMax), recreate(MAX_DISPATCH), probe('UNKNOWN', MAX_DISPATCH), 'PROBE_UNKNOWN', 'WATCHDOG'],
    ['NOT_FOUND on recreate = tombstone (S9)', claimed(), recreate(), probe('NOT_FOUND'), 'REDISPATCH', 'S9'],
    ['tombstone at seq = MAX (S10)', claimed(atMax), recreate(MAX_DISPATCH), probe('NOT_FOUND', MAX_DISPATCH), 'FAIL', 'S10'],
    ['tombstone with attempts = MAX (S8)', claimed({ processing: { attempts: MAX_ATTEMPTS } }), recreate(), probe('NOT_FOUND'), 'FAIL', 'S8'],
    ['NOT_FOUND on a fresh generation is only rechecked', claimed(fresh), redispatch(), probe('NOT_FOUND', 2), 'RECHECK', 'WATCHDOG'],
    ['NOT_FOUND on a fresh generation at seq = MAX', claimed(atMax), redispatch(MAX_DISPATCH), probe('NOT_FOUND', MAX_DISPATCH), 'RECHECK', 'WATCHDOG'],
  ];

  it.each(rows)('%s → %s', (_name, state, order, p, kind, transition) => {
    const d = decideVerifyResult(state === null ? null : deepFreeze(state), order, p, now);
    expect(d.kind).toBe(kind);
    expect(d.write?.transition ?? null).toBe(transition);
    if (state !== null && d.write !== null) apply(state, d.write);
  });

  it('EXISTS backs off like step 4 and leaves seq and status alone', () => {
    const before = claimed({ dispatch: { checks: 1 } });
    const d = decideVerifyResult(before, recreate(), probe('EXISTS'), now);
    expect(d.write?.next).toEqual({ ...before, dispatch: { ...before.dispatch, checks: 2 }, watchdogAt: now + 4 * MIN });
    expect(d.write?.events).toEqual([]);
  });

  it.each([
    ['UNKNOWN on a recreate', 'UNKNOWN', recreate()],
    ['NOT_FOUND on a fresh generation', 'NOT_FOUND', redispatch(1)],
  ] as const)('%s changes only the watchdog (+1 min)', (_name, result, order) => {
      const before = claimed();
      const d = decideVerifyResult(deepFreeze(before), order, probe(result), now);
      expect(d.write?.next).toEqual({ ...before, watchdogAt: now + SHORT_RECHECK_MS });
      expect(d.write?.events).toEqual([]);
  });

  it('a verified tombstone redispatches once; the new order cannot increment seq again', () => {
    const before = claimed();
    const d = decideVerifyResult(before, recreate(), probe('NOT_FOUND'), now);
    if (d.kind !== 'REDISPATCH') throw new Error(d.kind);
    expect(d.enqueue).toEqual({ seq: 2, purpose: 'REDISPATCH', claim: now + SHORT_RECHECK_MS });
    expect(d.write.events.map((e) => [e.id, e.details])).toEqual([['REDISPATCHED-s2', { reason: 'TOMBSTONE' }]]);
    const after = apply(before, d.write);
    expect(decideEnqueueResult(after, d.enqueue, { result: 'ALREADY_EXISTS' }, now + 1).kind).toBe('VERIFY_TASK');
    const again = decideVerifyResult(after, d.enqueue, probe('NOT_FOUND', 2), now + 2);
    expect(again.kind).toBe('RECHECK');
    expect(again.write?.next.dispatch.seq).toBe(2);
  });

  it('dispatch budget is consumed only by a NOT_FOUND after ALREADY_EXISTS on a RECREATE order', () => {
    const states = [claimed(), claimed(fresh), claimed(atMax), claimed({ processing: { attempts: 3 } })];
    for (const state of states) {
      for (const purpose of ['RECREATE', 'REDISPATCH'] as const) {
        for (const result of ['EXISTS', 'NOT_FOUND', 'UNKNOWN'] as const) {
          const order: EnqueueOrder = { seq: state.dispatch.seq, purpose, claim };
          const d = decideVerifyResult(state, order, probe(result, order.seq), now);
          const consumed = d.write !== null && (d.write.next.dispatch.seq !== state.dispatch.seq || d.write.next.status === 'FAILED');
          expect(consumed, `${purpose} ${result} at seq ${state.dispatch.seq}`).toBe(purpose === 'RECREATE' && result === 'NOT_FOUND');
        }
      }
    }
  });

  it('decideEnqueueResult never changes seq or status, whatever createTask answers', () => {
    const outcomes: EnqueueOutcome[] = [
      { result: 'CREATED' },
      { result: 'ALREADY_EXISTS' },
      { result: 'FAILED', error: { code: 'DEADLINE_EXCEEDED', message: 'timeout' } },
    ];
    for (const state of [claimed(), claimed(fresh), claimed(atMax)]) {
      for (const purpose of ['RECREATE', 'REDISPATCH'] as const) {
        for (const outcome of outcomes) {
          const d = decideEnqueueResult(state, { seq: state.dispatch.seq, purpose, claim }, outcome, now);
          expect(d.write?.next.dispatch.seq ?? state.dispatch.seq).toBe(state.dispatch.seq);
          expect(d.write?.next.status ?? state.status).toBe(state.status);
        }
      }
    }
  });
});
