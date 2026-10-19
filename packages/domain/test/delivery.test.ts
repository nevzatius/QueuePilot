import { describe, expect, it } from 'vitest';
import {
  LEASE_GRACE_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_DISPATCH,
  decideCompletion,
  decideDelivery,
  type DeliveryDecision,
  type RequestState,
} from '../src/index.js';
import { T0, accepted, apply, completed, deepFreeze, failed, processing } from './fixtures.js';

const delivery = (seq = 1) => ({ seq, leaseId: 'lease-new' });

describe('decideDelivery: decision table (first match wins)', () => {
  const rows: Array<[string, RequestState | null, number, DeliveryDecision['kind'], DeliveryDecision['http']]> = [
    ['no document', null, 1, 'ORPHAN', 200],
    ['COMPLETED', completed(), 1, 'DUPLICATE_SUPPRESSED', 200],
    ['FAILED', failed('PERMANENT_ERROR'), 1, 'DUPLICATE_SUPPRESSED', 200],
    ['terminal beats stale seq', completed({ dispatch: { seq: 2 } }), 1, 'DUPLICATE_SUPPRESSED', 200],
    ['older order\'s task: a valid wake-up', accepted({ dispatch: { seq: 2 } }), 1, 'ACQUIRE_LEASE', null],
    ['older order\'s task, lease valid', processing({ dispatch: { seq: 2 } }), 1, 'LEASE_HELD', 409],
    ['seq > dispatch.seq (anomaly)', accepted(), 2, 'FUTURE_DISPATCH', 200],
    ['PROCESSING, lease valid', processing(), 1, 'LEASE_HELD', 409],
    ['ACCEPTED, attempts = MAX', accepted({ processing: { attempts: MAX_ATTEMPTS } }), 1, 'FAIL', 200],
    ['PROCESSING expired, attempts = MAX', processing({ leaseExpiresAt: T0, processing: { attempts: MAX_ATTEMPTS } }), 1, 'FAIL', 200],
    ['valid lease beats attempts = MAX', processing({ processing: { attempts: MAX_ATTEMPTS } }), 1, 'LEASE_HELD', 409],
    ['ACCEPTED (S2)', accepted(), 1, 'ACQUIRE_LEASE', null],
    ['PROCESSING, lease expired (S3)', processing({ leaseExpiresAt: T0 }), 1, 'ACQUIRE_LEASE', null],
  ];

  it.each(rows)('%s → %s', (_name, state, seq, kind, http) => {
    const decision = decideDelivery(state === null ? null : deepFreeze(state), delivery(seq), T0);
    expect(decision.kind).toBe(kind);
    expect(decision.http).toBe(http);
  });
});

describe('decideDelivery: effects', () => {
  it('S2: ACCEPTED → PROCESSING with a new lease, attempts++ and deliveredSeq = seq', () => {
    const before = accepted({ dispatch: { checks: 3 } });
    const d = decideDelivery(before, delivery(), T0);
    if (d.kind !== 'ACQUIRE_LEASE') throw new Error(d.kind);
    const next = apply(before, d.write);
    expect(d.write.transition).toBe('S2');
    expect(d).toMatchObject({ attempt: 1, takeover: false, lease: { id: 'lease-new', expiresAt: T0 + LEASE_MS } });
    expect(next).toMatchObject({
      status: 'PROCESSING',
      processing: { attempts: 1, lease: { id: 'lease-new', expiresAt: T0 + LEASE_MS } },
      dispatch: { seq: 1, deliveredSeq: 1, checks: 0 },
      watchdogAt: T0 + LEASE_MS + LEASE_GRACE_MS,
      startedAt: T0,
    });
    expect(d.write.events.map((e) => e.id)).toEqual(['PROCESSING_STARTED-a1']);
  });

  it('S3: takeover of an expired lease records LEASE_TAKEOVER and keeps the first startedAt', () => {
    const before = processing({ leaseId: 'old', leaseExpiresAt: T0 - 1, processing: { attempts: 2 }, startedAt: T0 - 300_000 });
    const d = decideDelivery(before, delivery(), T0);
    if (d.kind !== 'ACQUIRE_LEASE') throw new Error(d.kind);
    const next = apply(before, d.write);
    expect(d.write.transition).toBe('S3');
    expect(d.takeover).toBe(true);
    expect(next.processing).toMatchObject({ attempts: 3, lease: { id: 'lease-new' } });
    expect(next.startedAt).toBe(T0 - 300_000);
    expect(d.write.events.map((e) => [e.id, e.details])).toEqual([
      ['PROCESSING_STARTED-a3', undefined],
      ['LEASE_TAKEOVER-a3', { previousLeaseExpiresAt: T0 - 1 }],
    ]);
  });

  it('S8: exhausted attempt budget fails the request without processing', () => {
    const before = accepted({ processing: { attempts: MAX_ATTEMPTS } });
    const d = decideDelivery(before, delivery(), T0);
    if (d.kind !== 'FAIL') throw new Error(d.kind);
    const next = apply(before, d.write);
    expect(d.write.transition).toBe('S8');
    expect(next).toMatchObject({ status: 'FAILED', statusReason: 'ATTEMPTS_EXHAUSTED', watchdogAt: null, completedAt: T0 });
    expect(next.processing.attempts).toBe(MAX_ATTEMPTS);
    expect(d.write.events.map((e) => e.id)).toEqual([`FAILED-a${MAX_ATTEMPTS}`]);
  });

  it('S11: a duplicate delivery to a terminal request only counts the duplicate', () => {
    const before = completed({ processing: { duplicateDeliveries: 2 } });
    const d = decideDelivery(before, delivery(), T0);
    if (d.kind !== 'DUPLICATE_SUPPRESSED') throw new Error(d.kind);
    const next = apply(before, d.write);
    expect(d.write.transition).toBe('S11');
    expect(next).toEqual({ ...before, processing: { ...before.processing, duplicateDeliveries: 3 } });
    expect(d.write.events).toEqual([]);
  });

  it('an older order\'s task acquires the lease; deliveredSeq never decreases (ADR-017)', () => {
    const before = accepted({ dispatch: { seq: 3, deliveredSeq: 2 } });
    const d = decideDelivery(before, delivery(1), T0);
    if (d.kind !== 'ACQUIRE_LEASE') throw new Error(d.kind);
    expect(apply(before, d.write).dispatch).toMatchObject({ seq: 3, deliveredSeq: 2 });
    expect(d.write.events.map((e) => [e.id, e.seq])).toEqual([['PROCESSING_STARTED-a1', 3]]);
  });

  it('a lease and every lease-holder outcome clear attention (any worker progress)', () => {
    const attention = { seq: MAX_DISPATCH + 1, attentionSince: T0 - 1 };
    const before = accepted({ dispatch: attention });
    const d = decideDelivery(before, delivery(MAX_DISPATCH + 1), T0);
    if (d.kind !== 'ACQUIRE_LEASE') throw new Error(d.kind);
    expect(apply(before, d.write).dispatch.attentionSince).toBeNull();
    // A reconciler may order again while an expired lease is still held; the holder's outcome clears it.
    const held = processing({ leaseExpiresAt: T0 - 1, dispatch: attention });
    for (const outcome of [
      { kind: 'SUCCESS', result: { rulesVersion: 'triage-v1', lane: 'standard', slaTargetMinutes: 60, team: 't', score: 1 } },
      { kind: 'TRANSIENT_ERROR', error: { code: 'E', message: 'e' } },
      { kind: 'PERMANENT_ERROR', error: { code: 'E', message: 'e' } },
    ] as const) {
      const c = decideCompletion(held, 'lease-1', outcome, T0);
      expect(c.write === null ? null : apply(held, c.write).dispatch.attentionSince, outcome.kind).toBeNull();
    }
  });

  it('honours a non-default attempt budget (after an admin retry)', () => {
    const raised = accepted({ processing: { attempts: MAX_ATTEMPTS, maxAttempts: 2 * MAX_ATTEMPTS } });
    expect(decideDelivery(raised, delivery(), T0).kind).toBe('ACQUIRE_LEASE');
  });
});

describe('decideDelivery: concurrency boundaries', () => {
  it('a lease is valid until 1 ms before expiresAt and can be taken over at expiresAt', () => {
    const exp = T0 + 10_000;
    expect(decideDelivery(processing({ leaseExpiresAt: exp }), delivery(), exp - 1).kind).toBe('LEASE_HELD');
    expect(decideDelivery(processing({ leaseExpiresAt: exp }), delivery(), exp).kind).toBe('ACQUIRE_LEASE');
  });

  it('PROCESSING without a stored lease is treated as expired (no holder can commit anyway)', () => {
    const corrupt = { ...processing(), processing: { ...processing().processing, lease: null } };
    expect(decideDelivery(corrupt, delivery(), T0).kind).toBe('ACQUIRE_LEASE');
  });

  it('T8: two serialised deliveries of the same task yield one lease and one 409', () => {
    const start = accepted();
    const first = decideDelivery(start, { seq: 1, leaseId: 'A' }, T0);
    if (first.kind !== 'ACQUIRE_LEASE') throw new Error(first.kind);
    const afterFirst = apply(start, first.write);
    const second = decideDelivery(afterFirst, { seq: 1, leaseId: 'B' }, T0 + 5);
    expect(second).toEqual({ kind: 'LEASE_HELD', http: 409, write: null });
  });

  it('only ACQUIRE_LEASE, FAIL and DUPLICATE_SUPPRESSED write; every other row is write-free', () => {
    const writeFree = [
      decideDelivery(null, delivery(), T0),
      decideDelivery(accepted(), delivery(2), T0),
      decideDelivery(processing(), delivery(), T0),
    ];
    for (const d of writeFree) expect(d.write).toBeNull();
  });
});
