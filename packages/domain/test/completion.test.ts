import type { TriageResult } from '@queuepilot/contracts';
import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  RETRY_WATCHDOG_MS,
  decideCompletion,
  decideDelivery,
  type CompletionDecision,
  type ProcessingOutcome,
  type RequestState,
} from '../src/index.js';
import { T0, accepted, apply, completed, deepFreeze, failed, processing } from './fixtures.js';

const RESULT: TriageResult = { rulesVersion: 'triage-v1', lane: 'standard', slaTargetMinutes: 90, team: 'roadside-urban', score: 35 };
const success: ProcessingOutcome = { kind: 'SUCCESS', result: RESULT };
const transient: ProcessingOutcome = { kind: 'TRANSIENT_ERROR', error: { code: 'CAPACITY_TIMEOUT', message: 'lookup timed out' } };
const permanent: ProcessingOutcome = { kind: 'PERMANENT_ERROR', error: { code: 'UNKNOWN_RULES_VERSION', message: 'no rules' } };

describe('decideCompletion: transitions S4-S7 and lease fencing (I4)', () => {
  const lastAttempt = processing({ processing: { attempts: MAX_ATTEMPTS } });
  const rows: Array<[string, RequestState | null, string, ProcessingOutcome, CompletionDecision['kind'], number, string | null]> = [
    ['S4 success', processing(), 'lease-1', success, 'COMPLETE', 200, 'S4'],
    ['S5 transient, attempts < MAX', processing(), 'lease-1', transient, 'RETRY', 503, 'S5'],
    ['S5 at attempts = MAX-1', processing({ processing: { attempts: MAX_ATTEMPTS - 1 } }), 'lease-1', transient, 'RETRY', 503, 'S5'],
    ['S6 transient, attempts = MAX', lastAttempt, 'lease-1', transient, 'FAIL', 200, 'S6'],
    ['S7 permanent', processing(), 'lease-1', permanent, 'FAIL', 200, 'S7'],
    ['S7 permanent on the last attempt', lastAttempt, 'lease-1', permanent, 'FAIL', 200, 'S7'],
    ['fenced: no document', null, 'lease-1', success, 'FENCED', 200, null],
    ['fenced: COMPLETED', completed(), 'lease-1', success, 'FENCED', 200, null],
    ['fenced: FAILED', failed('ATTEMPTS_EXHAUSTED'), 'lease-1', transient, 'FENCED', 200, null],
    ['fenced: back in ACCEPTED', accepted({ processing: { attempts: 1 } }), 'lease-1', success, 'FENCED', 409, null],
    ['fenced: lease taken over', processing({ leaseId: 'lease-2' }), 'lease-1', success, 'FENCED', 409, null],
    ['fenced: permanent error with a foreign lease', processing({ leaseId: 'lease-2' }), 'lease-1', permanent, 'FENCED', 409, null],
  ];

  it.each(rows)('%s', (_name, state, leaseId, outcome, kind, http, transition) => {
    const d = decideCompletion(state === null ? null : deepFreeze(state), leaseId, outcome, T0);
    expect(d.kind).toBe(kind);
    expect(d.http).toBe(http);
    expect(d.write?.transition ?? null).toBe(transition);
    if (state !== null && d.write !== null) apply(state, d.write);
  });
});

describe('decideCompletion: effects', () => {
  it('S4 stores the result, clears lease and watchdog, and sets completedAt', () => {
    const before = processing();
    const d = decideCompletion(before, 'lease-1', success, T0);
    if (d.kind !== 'COMPLETE') throw new Error(d.kind);
    expect(d.result).toEqual(RESULT);
    expect(apply(before, d.write)).toMatchObject({
      status: 'COMPLETED',
      statusReason: null,
      processing: { attempts: 1, lease: null },
      watchdogAt: null,
      completedAt: T0,
    });
    expect(d.write.events.map((e) => e.id)).toEqual(['COMPLETED-a1']);
  });

  it('S5 returns to ACCEPTED (shown as RETRYING), records lastError and sets watchdog +5m', () => {
    const before = processing({ processing: { attempts: 2 } });
    const d = decideCompletion(before, 'lease-1', transient, T0);
    if (d.kind !== 'RETRY') throw new Error(d.kind);
    expect(apply(before, d.write)).toMatchObject({
      status: 'ACCEPTED',
      processing: { attempts: 2, lease: null, lastError: { code: 'CAPACITY_TIMEOUT', message: 'lookup timed out', at: T0 } },
      watchdogAt: T0 + RETRY_WATCHDOG_MS,
    });
    expect(d.write.events.map((e) => e.id)).toEqual(['RETRY_SCHEDULED-a2']);
  });

  it('S6 / S7 record the reason and the last error', () => {
    const s6 = decideCompletion(processing({ processing: { attempts: MAX_ATTEMPTS } }), 'lease-1', transient, T0);
    const s7 = decideCompletion(processing(), 'lease-1', permanent, T0);
    expect(s6.write?.next).toMatchObject({ status: 'FAILED', statusReason: 'ATTEMPTS_EXHAUSTED', watchdogAt: null });
    expect(s7.write?.next).toMatchObject({ status: 'FAILED', statusReason: 'PERMANENT_ERROR', watchdogAt: null });
    expect(s7.write?.next.processing.lastError?.code).toBe('UNKNOWN_RULES_VERSION');
    expect(s6.write?.events.map((e) => e.id)).toEqual([`FAILED-a${MAX_ATTEMPTS}`]);
  });

  it('a matching lease commits even after expiry when nobody took over', () => {
    const d = decideCompletion(processing({ leaseExpiresAt: T0 - 1 }), 'lease-1', success, T0);
    expect(d.kind).toBe('COMPLETE');
  });
});

describe('decideCompletion: concurrency boundaries', () => {
  it('T10: after a takeover the late completion of the old holder is fenced out', () => {
    const held = processing({ leaseId: 'A', leaseExpiresAt: T0 });
    const takeover = decideDelivery(held, { seq: 1, leaseId: 'B' }, T0);
    if (takeover.kind !== 'ACQUIRE_LEASE') throw new Error(takeover.kind);
    const afterTakeover = apply(held, takeover.write);

    const late = decideCompletion(afterTakeover, 'A', success, T0 + 1);
    expect(late).toEqual({ kind: 'FENCED', http: 409, reason: 'LEASE_MISMATCH', write: null });
    const current = decideCompletion(afterTakeover, 'B', success, T0 + 2);
    expect(current.kind).toBe('COMPLETE');
  });

  it('a stale completion never changes a terminal request (I3)', () => {
    for (const terminal of [completed(), failed('PERMANENT_ERROR'), failed('DISPATCH_EXHAUSTED')]) {
      for (const outcome of [success, transient, permanent]) {
        const d = decideCompletion(deepFreeze(terminal), 'lease-1', outcome, T0);
        expect(d).toEqual({ kind: 'FENCED', http: 200, reason: 'TERMINAL', write: null });
      }
    }
  });
});
