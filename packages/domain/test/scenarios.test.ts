import { describe, expect, it } from 'vitest';
import {
  ATTENTION_REDISPATCH_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_DISPATCH,
  RETRY_WATCHDOG_MS,
  decideAdminRetry,
  decideCompletion,
  decideDelivery,
  decideEnqueueResult,
  decideReconcile,
  isStuck,
  needsAttention,
  planAcceptance,
  type EnqueueOrder,
  type EnqueueOutcome,
  type ProcessingOutcome,
  type DomainEvent,
  type ProbeResult,
  type RequestState,
  type StateWrite,
} from '../src/index.js';
import { MIN, T0, apply } from './fixtures.js';

/**
 * Domain-level replays of the B4 failure catalogue (docs/TASKS.md, T1-T16, as amended by ADR-017). Each
 * step feeds the state produced by the previous decision into the next one, exactly as serialised Firestore
 * transactions would. Queue behaviour is described by the inputs (probe results, createTask outcomes,
 * deliveries).
 */
class Sim {
  state: RequestState;
  /** Every committed timeline event, in commit order. */
  readonly events: DomainEvent[] = [];
  private leases = 0;
  constructor(public now = T0) {
    const accepted = planAcceptance({ requestId: 'req', payloadFingerprint: 'fp', now }).write;
    this.state = apply(null, accepted);
    this.events.push(...accepted.events);
  }
  at(t: number): this {
    this.now = t;
    return this;
  }
  private commit(write: StateWrite | null): void {
    if (write === null) return;
    this.state = apply(this.state, write);
    this.events.push(...write.events);
  }
  deliver(seq = this.state.dispatch.seq) {
    const d = decideDelivery(this.state, { seq, leaseId: `L${++this.leases}` }, this.now);
    this.commit(d.write);
    return d;
  }
  complete(leaseId: string, outcome: ProcessingOutcome) {
    const d = decideCompletion(this.state, leaseId, outcome, this.now);
    this.commit(d.write);
    return d;
  }
  /** One reconciler pass: planning read, probe, then the transactional decision. */
  reconcile(result: ProbeResult) {
    const plan = decideReconcile(this.state, null, this.now);
    const d = plan.kind === 'PROBE_TASK' ? decideReconcile(this.state, { seq: plan.seq, result }, this.now) : plan;
    this.commit(d.write);
    return d;
  }
  enqueued(order: EnqueueOrder, outcome: EnqueueOutcome) {
    const d = decideEnqueueResult(this.state, order, outcome, this.now);
    this.commit(d.write);
    return d;
  }
  /** S12 (P1). */
  adminRetry() {
    const d = decideAdminRetry(this.state, 'admin', this.now);
    this.commit(d.write);
    return d;
  }
}

const OK: ProcessingOutcome = {
  kind: 'SUCCESS',
  result: { rulesVersion: 'triage-v1', lane: 'standard', slaTargetMinutes: 90, team: 'roadside-urban', score: 35 },
};
const TRANSIENT: ProcessingOutcome = { kind: 'TRANSIENT_ERROR', error: { code: 'TIMEOUT', message: 'timeout' } };

function acquire(sim: Sim, seq?: number): string {
  const d = sim.deliver(seq);
  if (d.kind !== 'ACQUIRE_LEASE') throw new Error(`expected ACQUIRE_LEASE, got ${d.kind}`);
  return d.lease.id;
}

describe('failure catalogue at the decision level', () => {
  it('T1: createTask failed at the API → reconciler places a new order → COMPLETED, seq=2', () => {
    const sim = new Sim().at(T0 + MIN);
    const d = sim.reconcile('NOT_FOUND');
    if (d.kind !== 'DISPATCH') throw new Error(d.kind);
    expect(d.enqueue).toEqual({ seq: 2 });
    expect(sim.enqueued(d.enqueue, { result: 'CREATED' })).toMatchObject({ kind: 'NOOP', reason: 'UNCHANGED' });
    expect(sim.complete(acquire(sim), OK).kind).toBe('COMPLETE');
    expect(sim.state).toMatchObject({ status: 'COMPLETED', dispatch: { seq: 2 }, processing: { attempts: 1 } });
  });

  it('T2: ambiguous createTask → probe EXISTS → wait; one completion, seq=1', () => {
    const sim = new Sim().at(T0 + MIN);
    expect(sim.reconcile('EXISTS').kind).toBe('WAIT_FOR_TASK');
    expect(sim.complete(acquire(sim), OK).kind).toBe('COMPLETE');
    expect(sim.deliver().kind).toBe('DUPLICATE_SUPPRESSED');
    expect(sim.state).toMatchObject({ status: 'COMPLETED', dispatch: { seq: 1 } });
  });

  it('T3: queue paused for 30 min → reconciler only waits (no seq++), then completes after resume', () => {
    const sim = new Sim();
    const passes: number[] = [];
    for (let t = T0; t <= T0 + 30 * MIN; t += MIN) {
      const d = sim.at(t).reconcile('EXISTS');
      if (d.kind === 'WAIT_FOR_TASK') passes.push((t - T0) / MIN);
    }
    expect(passes).toEqual([1, 3, 7, 15, 30]);
    expect(sim.state.dispatch).toMatchObject({ seq: 1, checks: 5 });
    expect(isStuck(sim.state, sim.now)).toBe(false);
    expect(sim.complete(acquire(sim), OK).kind).toBe('COMPLETE');
    expect(sim.state.dispatch.seq).toBe(1);
  });

  it('T4: pre-lease failures exhaust the task → NOT_FOUND → new order seq=2, attempts=0, no tombstone logic', () => {
    const sim = new Sim().at(T0 + 20 * MIN);
    const d = sim.reconcile('NOT_FOUND');
    if (d.kind !== 'DISPATCH') throw new Error(d.kind);
    expect(sim.state).toMatchObject({ status: 'ACCEPTED', dispatch: { seq: 2, deliveredSeq: 0 }, processing: { attempts: 0 } });
    expect(sim.complete(acquire(sim, 2), OK).kind).toBe('COMPLETE');
  });

  it('T5: crash after lease → 409 until the lease expires → takeover, attempts=2, one COMPLETED', () => {
    const sim = new Sim();
    acquire(sim); // the worker crashes after this commit
    expect(sim.at(T0 + 10_000).deliver().kind).toBe('LEASE_HELD');
    expect(sim.at(T0 + LEASE_MS - 1).deliver().http).toBe(409);
    const d = sim.at(T0 + LEASE_MS).deliver();
    if (d.kind !== 'ACQUIRE_LEASE') throw new Error(d.kind);
    expect(d.takeover).toBe(true);
    expect(sim.complete(d.lease.id, OK).kind).toBe('COMPLETE');
    expect(sim.state.processing.attempts).toBe(2);
  });

  it('T6: crash after the completion commit → the retry gets 200, duplicateDeliveries=1', () => {
    const sim = new Sim();
    sim.complete(acquire(sim), OK);
    const retry = sim.deliver();
    expect(retry).toMatchObject({ kind: 'DUPLICATE_SUPPRESSED', http: 200 });
    expect(sim.state).toMatchObject({ status: 'COMPLETED', processing: { duplicateDeliveries: 1 } });
  });

  it('T7: transient failure on the last attempt → FAILED(ATTEMPTS_EXHAUSTED)', () => {
    const sim = new Sim();
    const https: number[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i++) https.push(sim.at(T0 + i * MIN).complete(acquire(sim), TRANSIENT).http);
    expect(https).toEqual([503, 503, 503, 503, 200]);
    expect(sim.state).toMatchObject({ status: 'FAILED', statusReason: 'ATTEMPTS_EXHAUSTED', processing: { attempts: MAX_ATTEMPTS } });
    expect(sim.deliver().kind).toBe('DUPLICATE_SUPPRESSED');
  });

  it('T9: an older order\'s task is a valid wake-up: it processes a runnable request, and is absorbed once terminal', () => {
    const sim = new Sim().at(T0 + MIN);
    sim.reconcile('NOT_FOUND'); // order seq 2; the API's seq-1 task turns up late
    const d = sim.deliver(1);
    if (d.kind !== 'ACQUIRE_LEASE') throw new Error(d.kind);
    expect(sim.complete(d.lease.id, OK).kind).toBe('COMPLETE');
    expect(sim.deliver(2)).toMatchObject({ kind: 'DUPLICATE_SUPPRESSED', http: 200 });
    expect(sim.state).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 }, dispatch: { seq: 2, deliveredSeq: 1 } });
  });

  it('T11: two concurrent reconcilers place one order per due watchdog', () => {
    const sim = new Sim();
    sim.complete(acquire(sim), TRANSIENT); // delivered, back in ACCEPTED; then the task is lost
    const due = sim.state.watchdogAt as number;
    const snapshot = sim.state;

    // Both selected the request and both probed NOT_FOUND for seq=1. A commits first.
    const a = decideReconcile(snapshot, { seq: 1, result: 'NOT_FOUND' }, due);
    if (a.kind !== 'DISPATCH') throw new Error(a.kind);
    const afterA = apply(snapshot, a.write);
    // B's transaction re-reads A's commit.
    expect(decideReconcile(afterA, { seq: 1, result: 'NOT_FOUND' }, due).kind).toBe('NOOP');
    // Once A's order is due again, B's probe refers to an older order.
    expect(decideReconcile(afterA, { seq: 1, result: 'NOT_FOUND' }, due + RETRY_WATCHDOG_MS).kind).toBe('PROBE_STALE');
    expect(afterA.dispatch.seq).toBe(2);
  });

  it('T11: a stalled reconciler\'s late createTask result cannot touch a newer order', () => {
    const sim = new Sim().at(T0 + MIN);
    const a = sim.reconcile('NOT_FOUND');
    if (a.kind !== 'DISPATCH') throw new Error(a.kind);
    // A stalls past its order. B places the next one and records it.
    sim.at(sim.state.watchdogAt as number);
    const b = sim.reconcile('NOT_FOUND');
    if (b.kind !== 'DISPATCH') throw new Error(b.kind);
    // A's createTask finally answers, in any form. Its own name, its own result: nothing to decide.
    for (const outcome of [{ result: 'CREATED' }, { result: 'ALREADY_EXISTS' }] as const) {
      expect(sim.enqueued(a.enqueue, outcome)).toMatchObject({ kind: 'NOOP', reason: 'SUPERSEDED' });
    }
    expect(sim.state.dispatch.seq).toBe(3);
  });

  it('T12: reconciler off and createTask failed → stays ACCEPTED and stuck, recovered once it runs', () => {
    const sim = new Sim();
    expect(isStuck(sim.state, T0 + 10 * MIN)).toBe(false);
    expect(isStuck(sim.state, T0 + 17 * MIN)).toBe(true);
    expect(sim.state.status).toBe('ACCEPTED');
    const d = sim.at(T0 + 17 * MIN).reconcile('NOT_FOUND');
    if (d.kind !== 'DISPATCH') throw new Error(d.kind);
    sim.enqueued(d.enqueue, { result: 'CREATED' });
    expect(isStuck(sim.state, sim.now)).toBe(false);
    expect(sim.complete(acquire(sim), OK).kind).toBe('COMPLETE');
  });

  it('T13: permanent error → FAILED after one attempt', () => {
    const sim = new Sim();
    const d = sim.complete(acquire(sim), { kind: 'PERMANENT_ERROR', error: { code: 'BAD', message: 'bad' } });
    expect(d).toMatchObject({ kind: 'FAIL', http: 200, reason: 'PERMANENT_ERROR' });
    expect(sim.state).toMatchObject({ status: 'FAILED', statusReason: 'PERMANENT_ERROR', processing: { attempts: 1 } });
  });

  it('B4 extra: a getTask PERMISSION_DENIED (UNKNOWN) is not evidence; it only allows a safe new order', () => {
    const sim = new Sim();
    sim.complete(acquire(sim), TRANSIENT);
    const before = sim.state;
    const d = sim.at(before.watchdogAt as number).reconcile('UNKNOWN');
    expect(d).toMatchObject({ kind: 'DISPATCH', enqueue: { seq: 2 }, attention: false });
    expect(sim.state).toMatchObject({ status: 'ACCEPTED', processing: before.processing, dispatch: { seq: 2 } });
  });

  it('T16: repeated purges before delivery end in attention, never DISPATCH_EXHAUSTED; a delivery recovers', () => {
    const sim = new Sim();
    const kinds: string[] = [];
    for (let i = 0; i < MAX_DISPATCH + 2; i++) {
      const d = sim.at(sim.state.watchdogAt as number).reconcile('NOT_FOUND');
      if (d.kind !== 'DISPATCH') throw new Error(d.kind);
      kinds.push(d.write.transition);
    }
    expect(kinds).toEqual(['S9', 'S9', 'S10', 'S10', 'S10']);
    expect(sim.state).toMatchObject({ status: 'ACCEPTED', statusReason: null, processing: { attempts: 0 } });
    expect(needsAttention(sim.state)).toBe(true);
    expect(sim.state.watchdogAt).toBe(sim.now + ATTENTION_REDISPATCH_MS);
    expect(sim.complete(acquire(sim), OK).kind).toBe('COMPLETE');
    expect(sim.state.dispatch.attentionSince).toBeNull();
  });

  it('S12 (P1): every budget epoch gets MAX_ATTEMPTS starts; old tasks stay valid wake-ups; event IDs never repeat', () => {
    const sim = new Sim();
    const starts = () => sim.events.filter((e) => e.type === 'PROCESSING_STARTED').length;
    const retry = () => {
      const d = sim.adminRetry();
      if (d.kind !== 'RETRY') throw new Error(d.kind);
      expect(sim.enqueued(d.enqueue, { result: 'CREATED' }).kind).toBe('NOOP');
      return d.enqueue.seq;
    };

    // Epoch 1: transient errors until ATTEMPTS_EXHAUSTED.
    while (sim.state.status !== 'FAILED') sim.complete(acquire(sim), TRANSIENT);
    expect([starts(), sim.state.statusReason]).toEqual([MAX_ATTEMPTS, 'ATTEMPTS_EXHAUSTED']);

    // Epoch 2: the previous order's task arrives first and processes the request: permanent error.
    const firstSeq = retry();
    sim.complete(acquire(sim, firstSeq - 1), { kind: 'PERMANENT_ERROR', error: { code: 'BAD', message: 'bad' } });
    expect(sim.state.statusReason).toBe('PERMANENT_ERROR');

    // Epoch 3: success.
    retry();
    expect(sim.complete(acquire(sim), OK).kind).toBe('COMPLETE');

    const ids = sim.events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith('FAILED-'))).toEqual(['FAILED-a5', 'FAILED-a6']);
    expect(starts()).toBe(MAX_ATTEMPTS + 2);
    expect(sim.state).toMatchObject({ status: 'COMPLETED', processing: { attempts: 7, maxAttempts: 11 }, dispatch: { seq: 3, maxSeq: 5 } });
  });
});
