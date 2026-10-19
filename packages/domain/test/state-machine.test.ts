import { REQUEST_STATUSES, type RequestStatus } from '@queuepilot/contracts';
import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  MAX_DISPATCH,
  TRANSITIONS,
  TransitionViolation,
  attemptsRemaining,
  decideCompletion,
  decideDelivery,
  decideEnqueueResult,
  decideReconcile,
  eventId,
  isAllowedTransition,
  isStuck,
  stateViolations,
  stateWrite,
  taskName,
  type ProcessingOutcome,
  type RequestState,
  type StateWrite,
  type TransitionId,
} from '../src/index.js';
import { MIN, T0, accepted, completed, deepFreeze, failed, processing } from './fixtures.js';

describe('transition table (ARCHITECTURE §6)', () => {
  const rows: Array<[TransitionId, RequestStatus | null, RequestStatus, boolean]> = [
    ['S1', null, 'ACCEPTED', true],
    ['S2', 'ACCEPTED', 'PROCESSING', true],
    ['S3', 'PROCESSING', 'PROCESSING', true],
    ['S4', 'PROCESSING', 'COMPLETED', true],
    ['S5', 'PROCESSING', 'ACCEPTED', true],
    ['S6', 'PROCESSING', 'FAILED', true],
    ['S7', 'PROCESSING', 'FAILED', true],
    ['S8', 'ACCEPTED', 'FAILED', true],
    ['S8', 'PROCESSING', 'FAILED', true],
    ['S9', 'ACCEPTED', 'ACCEPTED', true],
    ['S9', 'PROCESSING', 'PROCESSING', true],
    ['S10', 'ACCEPTED', 'FAILED', true],
    ['S10', 'PROCESSING', 'FAILED', true],
    ['S11', 'COMPLETED', 'COMPLETED', true],
    ['S11', 'FAILED', 'FAILED', true],
    ['S12', 'FAILED', 'ACCEPTED', true],
    ['WATCHDOG', 'ACCEPTED', 'ACCEPTED', true],
    ['WATCHDOG', 'PROCESSING', 'PROCESSING', true],
    // Forbidden moves.
    ['S2', 'COMPLETED', 'PROCESSING', false],
    ['S4', 'ACCEPTED', 'COMPLETED', false],
    ['S9', 'ACCEPTED', 'PROCESSING', false],
    ['S11', 'COMPLETED', 'FAILED', false],
    ['S11', 'FAILED', 'ACCEPTED', false],
    ['S12', 'COMPLETED', 'ACCEPTED', false],
    ['WATCHDOG', 'COMPLETED', 'COMPLETED', false],
    ['WATCHDOG', 'ACCEPTED', 'FAILED', false],
  ];

  it.each(rows)('%s: %s → %s allowed=%s', (id, from, to, allowed) => {
    expect(isAllowedTransition(id, from, to)).toBe(allowed);
  });

  it('only S12 (admin) leaves a terminal status; COMPLETED is never left (I3)', () => {
    for (const [id, rule] of Object.entries(TRANSITIONS) as Array<[TransitionId, (typeof TRANSITIONS)[TransitionId]]>) {
      for (const from of ['COMPLETED', 'FAILED'] as const) {
        if (!rule.from.includes(from)) continue;
        const exits = REQUEST_STATUSES.filter((to) => to !== from && isAllowedTransition(id, from, to));
        expect(exits, `${id} from ${from}`).toEqual(id === 'S12' && from === 'FAILED' ? ['ACCEPTED'] : []);
      }
    }
  });

  it('stateWrite rejects illegal transitions and inconsistent states', () => {
    expect(() => stateWrite('S4', accepted(), completed())).toThrow(TransitionViolation);
    expect(() => stateWrite('WATCHDOG', accepted(), { ...accepted(), watchdogAt: null })).toThrow(/watchdog/);
  });
});

describe('state invariants', () => {
  it('fixtures are consistent', () => {
    for (const s of [accepted(), processing(), completed(), failed('PERMANENT_ERROR')]) expect(stateViolations(s)).toEqual([]);
  });

  it('detects each violated rule', () => {
    const p = processing();
    const cases: Array<[RequestState, string]> = [
      [{ ...accepted(), statusReason: 'PERMANENT_ERROR' }, 'statusReason iff FAILED'],
      [{ ...completed(), watchdogAt: T0 }, 'terminal requests have no watchdog'],
      [{ ...accepted(), watchdogAt: null }, 'non-terminal requests have a watchdog'],
      [{ ...accepted(), completedAt: T0 }, 'completedAt iff terminal'],
      [{ ...accepted(), processing: p.processing }, 'lease only while PROCESSING'],
      [{ ...p, processing: { ...p.processing, lease: null } }, 'PROCESSING requires a lease'],
      [accepted({ processing: { attempts: MAX_ATTEMPTS + 1 } }), '0 <= attempts <= maxAttempts'],
      [accepted({ dispatch: { seq: MAX_DISPATCH + 1 } }), '1 <= seq <= maxSeq'],
      [accepted({ dispatch: { deliveredSeq: 2 } }), '0 <= deliveredSeq <= seq'],
    ];
    for (const [state, rule] of cases) expect(stateViolations(state)).toContain(rule);
  });

  it('budgets, stuck detection and naming helpers', () => {
    expect(attemptsRemaining(accepted({ processing: { attempts: 3 } }))).toBe(MAX_ATTEMPTS - 3);
    expect(isStuck(accepted({ watchdogAt: T0 - 15 * MIN }), T0)).toBe(false);
    expect(isStuck(accepted({ watchdogAt: T0 - 15 * MIN - 1 }), T0)).toBe(true);
    expect(isStuck(completed(), T0 + 60 * MIN)).toBe(false);
    expect(taskName('abc', 2)).toBe('r-abc-2');
    expect(eventId('PROCESSING_STARTED', 3, 1)).toBe('PROCESSING_STARTED-a3');
    expect(eventId('REDISPATCHED', 3, 2)).toBe('REDISPATCHED-s2');
  });
});

/** A grid of representative states × every input each decision function accepts. */
function grid(): Array<{ name: string; state: RequestState }> {
  const states: Array<[string, RequestState]> = [
    ['accepted', accepted()],
    ['accepted retrying', accepted({ processing: { attempts: 2 }, dispatch: { deliveredSeq: 1 } })],
    ['accepted exhausted', accepted({ processing: { attempts: MAX_ATTEMPTS }, dispatch: { deliveredSeq: 1 } })],
    ['accepted seq=MAX delivered', accepted({ processing: { attempts: 1 }, dispatch: { seq: MAX_DISPATCH, deliveredSeq: MAX_DISPATCH } })],
    ['processing valid', processing()],
    ['processing expired', processing({ leaseExpiresAt: T0 - 1, watchdogAt: T0 - 1 })],
    ['processing last attempt', processing({ processing: { attempts: MAX_ATTEMPTS } })],
    ['completed', completed()],
    ['completed with watchdog', completed({ watchdogAt: T0 })],
    ['failed attempts', failed('ATTEMPTS_EXHAUSTED')],
    ['failed permanent', failed('PERMANENT_ERROR')],
    ['failed dispatch', failed('DISPATCH_EXHAUSTED', { dispatch: { seq: MAX_DISPATCH } })],
  ];
  return states.map(([name, state]) => ({ name, state: deepFreeze(state) }));
}

function allWrites(state: RequestState): Array<[string, StateWrite | null]> {
  const out: Array<[string, StateWrite | null]> = [];
  const outcomes: ProcessingOutcome[] = [
    { kind: 'SUCCESS', result: { rulesVersion: 'triage-v1', lane: 'standard', slaTargetMinutes: 60, team: 't', score: 1 } },
    { kind: 'TRANSIENT_ERROR', error: { code: 'E', message: 'e' } },
    { kind: 'PERMANENT_ERROR', error: { code: 'E', message: 'e' } },
  ];
  for (const now of [T0 - 1, T0, T0 + 5 * MIN]) {
    for (const seq of [1, 2, 3, 4]) out.push([`delivery seq=${seq} @${now}`, decideDelivery(state, { seq, leaseId: 'X' }, now).write]);
    for (const leaseId of ['lease-1', 'other']) {
      for (const o of outcomes) out.push([`completion ${leaseId} ${o.kind}`, decideCompletion(state, leaseId, o, now).write]);
    }
    for (const seq of [1, 2, 3]) {
      for (const result of ['EXISTS', 'NOT_FOUND', 'UNKNOWN'] as const) {
        out.push([`reconcile ${result} seq=${seq}`, decideReconcile(state, { seq, result }, now).write]);
      }
      for (const purpose of ['RECREATE', 'REDISPATCH'] as const) {
        for (const outcome of [{ result: 'CREATED' }, { result: 'ALREADY_EXISTS' }] as const) {
          const order = { seq, purpose, claim: state.watchdogAt ?? T0 };
          out.push([`enqueue ${purpose} ${outcome.result}`, decideEnqueueResult(state, order, outcome, now).write]);
        }
      }
    }
    out.push(['reconcile planning', decideReconcile(state, null, now).write]);
  }
  return out;
}

describe('properties over the decision grid', () => {
  it.each(grid())('$name: every write is an allowed transition to a consistent state', ({ state }) => {
    for (const [label, write] of allWrites(state)) {
      if (write === null) continue;
      expect(isAllowedTransition(write.transition, state.status, write.next.status), label).toBe(true);
      expect(stateViolations(write.next), label).toEqual([]);
    }
  });

  it.each(grid().filter(({ state }) => state.status === 'COMPLETED' || state.status === 'FAILED'))(
    '$name: no worker or reconciler decision changes a terminal request (I3)',
    ({ state }) => {
      for (const [label, write] of allWrites(state)) {
        if (write === null) continue;
        expect(write.transition, label).toBe('S11');
        // Only bookkeeping may change: the duplicate counter and a leftover watchdog.
        const normalise = (s: RequestState) => ({ ...s, processing: { ...s.processing, duplicateDeliveries: 0 }, watchdogAt: null });
        expect(normalise(write.next), label).toEqual(normalise(state));
      }
    },
  );

  it.each(grid())('$name: counters never decrease and attempts never exceed the budget (I5)', ({ state }) => {
    for (const [label, write] of allWrites(state)) {
      if (write === null) continue;
      const { processing: p, dispatch: d } = write.next;
      expect(p.attempts, label).toBeGreaterThanOrEqual(state.processing.attempts);
      expect(p.attempts - state.processing.attempts, label).toBeLessThanOrEqual(1);
      expect(p.attempts, label).toBeLessThanOrEqual(p.maxAttempts);
      expect(d.seq - state.dispatch.seq, label).toBeGreaterThanOrEqual(0);
      expect(d.seq - state.dispatch.seq, label).toBeLessThanOrEqual(1);
      expect(d.deliveredSeq, label).toBeGreaterThanOrEqual(state.dispatch.deliveredSeq);
    }
  });

  it.each(grid())('$name: decisions are deterministic and do not mutate their input', ({ state }) => {
    // Inputs are deep-frozen by grid(); a mutation would throw in strict mode.
    expect(allWrites(state)).toEqual(allWrites(state));
  });
});
