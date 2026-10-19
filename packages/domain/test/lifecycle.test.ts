import { describe, expect, it } from 'vitest';
import {
  CURRENT_RULES_VERSION,
  IDEMPOTENCY_WINDOW_MS,
  INITIAL_WATCHDOG_MS,
  MAX_ATTEMPTS,
  MAX_DISPATCH,
  RECONCILER_SHARDS,
  decideAdminRetry,
  decideDelivery,
  decideEnqueueResult,
  decideIdempotency,
  isIdempotencyExpired,
  newIdempotencyRecord,
  planAcceptance,
  watchdogShardFor,
  type IdempotencyDecision,
  type IdempotencyRecord,
} from '../src/index.js';
import { T0, apply, completed, deepFreeze, failed, processing, accepted } from './fixtures.js';

const REQUEST_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('S1: acceptance', () => {
  it('creates ACCEPTED with seq=1, deliveredSeq=0, attempts=0 and watchdog +60 s', () => {
    const a = planAcceptance({ requestId: REQUEST_ID, payloadFingerprint: 'fp', now: T0 });
    const state = apply(null, a.write);
    expect(a.write.transition).toBe('S1');
    expect(state).toEqual({
      status: 'ACCEPTED',
      statusReason: null,
      processing: { attempts: 0, maxAttempts: MAX_ATTEMPTS, lease: null, lastError: null, duplicateDeliveries: 0 },
      dispatch: { seq: 1, deliveredSeq: 0, checks: 0, maxSeq: MAX_DISPATCH, lastError: null },
      watchdogAt: T0 + INITIAL_WATCHDOG_MS,
      startedAt: null,
      completedAt: null,
    });
    expect(a.write.events).toEqual([{ id: 'ACCEPTED-s1', type: 'ACCEPTED', at: T0, actor: 'api', attempt: 0, seq: 1 }]);
    expect(a.idempotency).toEqual({ requestId: REQUEST_ID, payloadFingerprint: 'fp', createdAt: T0, expiresAt: T0 + IDEMPOTENCY_WINDOW_MS });
    expect(a.rulesVersion).toBe(CURRENT_RULES_VERSION);
    expect(a.enqueue).toEqual({ seq: 1 });
  });

  it('assigns a reproducible shard in 0..3 that spreads random IDs over every shard', () => {
    expect(watchdogShardFor(REQUEST_ID)).toBe(watchdogShardFor(REQUEST_ID));
    const shards = new Set<number>();
    for (let i = 0; i < 64; i++) shards.add(watchdogShardFor(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    expect([...shards].sort()).toEqual([...Array(RECONCILER_SHARDS).keys()]);
  });
});

describe('idempotency: logical expiry (ADR-005, I2)', () => {
  const record: IdempotencyRecord = deepFreeze(newIdempotencyRecord(REQUEST_ID, 'fp-a', T0));
  const expiresAt = T0 + IDEMPOTENCY_WINDOW_MS;

  const rows: Array<[string, IdempotencyRecord | null, string, number, IdempotencyDecision]> = [
    ['absent', null, 'fp-a', T0, { kind: 'CREATE' }],
    ['same payload inside the window', record, 'fp-a', T0 + 1, { kind: 'REPLAY', requestId: REQUEST_ID }],
    ['same payload, last millisecond', record, 'fp-a', expiresAt - 1, { kind: 'REPLAY', requestId: REQUEST_ID }],
    ['different payload inside the window', record, 'fp-b', expiresAt - 1, { kind: 'CONFLICT', code: 'IDEMPOTENCY_KEY_REUSED', requestId: REQUEST_ID }],
    ['same payload at expiresAt', record, 'fp-a', expiresAt, { kind: 'TAKEOVER', expiredRequestId: REQUEST_ID }],
    ['different payload after expiry', record, 'fp-b', expiresAt + 1, { kind: 'TAKEOVER', expiredRequestId: REQUEST_ID }],
  ];

  it.each(rows)('%s', (_name, existing, fingerprint, now, expected) => {
    expect(decideIdempotency(existing, fingerprint, now)).toEqual(expected);
  });

  it('is honoured for exactly 24 h regardless of physical TTL deletion', () => {
    expect(isIdempotencyExpired(record, expiresAt - 1)).toBe(false);
    expect(isIdempotencyExpired(record, expiresAt)).toBe(true);
  });

  it('of two concurrent takeovers, the second re-reads the winner and replays', () => {
    const later = expiresAt + 5_000;
    expect(decideIdempotency(record, 'fp-a', later).kind).toBe('TAKEOVER');
    const winner = newIdempotencyRecord('second-request', 'fp-a', later);
    expect(decideIdempotency(winner, 'fp-a', later + 1)).toEqual({ kind: 'REPLAY', requestId: 'second-request' });
    expect(decideIdempotency(winner, 'fp-b', later + 1).kind).toBe('CONFLICT');
  });
});

describe('S12 (P1): admin retry', () => {
  it('rejects non-admins, missing documents and non-FAILED requests', () => {
    expect(decideAdminRetry(failed('PERMANENT_ERROR'), 'member', T0).kind).toBe('FORBIDDEN');
    expect(decideAdminRetry(null, 'admin', T0).kind).toBe('NOT_FOUND');
    for (const state of [accepted(), processing(), completed()]) {
      expect(decideAdminRetry(state, 'admin', T0).kind).toBe('NOT_RETRYABLE');
    }
  });

  it('FAILED → ACCEPTED with a new budget and seq++, keeping counters monotonic', () => {
    const before = failed('DISPATCH_EXHAUSTED', { processing: { attempts: 2 }, dispatch: { seq: MAX_DISPATCH, deliveredSeq: 2 } });
    const d = decideAdminRetry(deepFreeze(before), 'admin', T0);
    if (d.kind !== 'RETRY') throw new Error(d.kind);
    const next = apply(before, d.write);
    expect(d.write.transition).toBe('S12');
    expect(next).toMatchObject({
      status: 'ACCEPTED',
      statusReason: null,
      completedAt: null,
      watchdogAt: T0 + INITIAL_WATCHDOG_MS,
      processing: { attempts: 2, maxAttempts: 2 + MAX_ATTEMPTS, lease: null },
      dispatch: { seq: MAX_DISPATCH + 1, deliveredSeq: 2, checks: 0, maxSeq: 2 * MAX_DISPATCH },
    });
    expect(d.enqueue).toEqual({ seq: MAX_DISPATCH + 1, purpose: 'REDISPATCH', claim: T0 + INITIAL_WATCHDOG_MS });
    expect(d.write.events.map((e) => [e.id, e.actor, e.details])).toEqual([
      [`REDISPATCHED-s${MAX_DISPATCH + 1}`, 'admin', { reason: 'ADMIN_RETRY' }],
    ]);
  });

  it('after S12 the new task is delivered and processed under the new budget', () => {
    const before = failed('ATTEMPTS_EXHAUSTED');
    const retry = decideAdminRetry(before, 'admin', T0);
    if (retry.kind !== 'RETRY') throw new Error(retry.kind);
    const afterRetry = apply(before, retry.write);
    const enq = decideEnqueueResult(afterRetry, retry.enqueue, { result: 'CREATED' }, T0 + 1);
    if (enq.kind !== 'SCHEDULED') throw new Error(enq.kind);
    const afterEnqueue = apply(afterRetry, enq.write);
    const d = decideDelivery(afterEnqueue, { seq: retry.enqueue.seq, leaseId: 'L' }, T0 + 2);
    expect(d.kind).toBe('ACQUIRE_LEASE');
    expect(d.write?.events.map((e) => e.id)).toEqual([`PROCESSING_STARTED-a${MAX_ATTEMPTS + 1}`]);
  });
});
