import { describe, expect, it } from 'vitest';
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  decideCompletion,
  decideDelivery,
  decideEnqueueResult,
  decideReconcile,
  isStuck,
  planAcceptance,
  type EnqueueOrder,
  type EnqueueOutcome,
  type ProcessingOutcome,
  type ProbeResult,
  type RequestState,
  type StateWrite,
} from '../src/index.js';
import { MIN, T0, apply } from './fixtures.js';

/**
 * Domain-level replays of the B4 failure catalogue (docs/TASKS.md, T1-T13). Each step feeds the state
 * produced by the previous decision into the next one, exactly as serialised Firestore transactions
 * would. Queue behaviour is described by the inputs (probe results, createTask outcomes, deliveries).
 */
class Sim {
  state: RequestState;
  private leases = 0;
  constructor(public now = T0) {
    this.state = apply(null, planAcceptance({ requestId: 'req', payloadFingerprint: 'fp', now }).write);
  }
  at(t: number): this {
    this.now = t;
    return this;
  }
  private commit(write: StateWrite | null): void {
    if (write !== null) this.state = apply(this.state, write);
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
  it('T1: createTask failed at the API → reconciler recreates the same seq → COMPLETED, seq=1', () => {
    const sim = new Sim().at(T0 + MIN);
    const d = sim.reconcile('NOT_FOUND');
    if (d.kind !== 'RECREATE_TASK') throw new Error(d.kind);
    expect(sim.enqueued(d.enqueue, { result: 'CREATED' }).kind).toBe('SCHEDULED');
    expect(sim.complete(acquire(sim), OK).kind).toBe('COMPLETE');
    expect(sim.state).toMatchObject({ status: 'COMPLETED', dispatch: { seq: 1 }, processing: { attempts: 1 } });
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

  it('T4: pre-lease failures exhaust the task → NOT_FOUND, deliveredSeq=0, tombstone → seq=2, attempts=0', () => {
    const sim = new Sim().at(T0 + 20 * MIN);
    const d = sim.reconcile('NOT_FOUND');
    if (d.kind !== 'RECREATE_TASK') throw new Error(d.kind);
    const t = sim.enqueued(d.enqueue, { result: 'ALREADY_EXISTS' });
    if (t.kind !== 'REDISPATCH') throw new Error(t.kind);
    expect(sim.enqueued(t.enqueue, { result: 'CREATED' }).kind).toBe('SCHEDULED');
    expect(sim.state).toMatchObject({ status: 'ACCEPTED', dispatch: { seq: 2, deliveredSeq: 0 }, processing: { attempts: 0 } });
    expect(sim.deliver(1).kind).toBe('STALE_DISPATCH');
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

  it('T9: a stale seq delivery returns 200 without processing', () => {
    const sim = new Sim();
    sim.state = { ...sim.state, dispatch: { ...sim.state.dispatch, seq: 2 } };
    const before = sim.state;
    expect(sim.deliver(1)).toEqual({ kind: 'STALE_DISPATCH', http: 200, write: null });
    expect(sim.state).toBe(before);
  });

  it('T11: two concurrent reconcilers increment seq at most once per proven loss', () => {
    const sim = new Sim();
    sim.complete(acquire(sim), TRANSIENT); // delivered, back in ACCEPTED; then the task is lost
    const due = sim.state.watchdogAt as number;
    const snapshot = sim.state;

    // Both selected the request and both probed NOT_FOUND for seq=1. A commits first.
    const a = decideReconcile(snapshot, { seq: 1, result: 'NOT_FOUND' }, due);
    if (a.kind !== 'REDISPATCH') throw new Error(a.kind);
    const afterA = apply(snapshot, a.write);
    // B's transaction re-reads A's commit.
    expect(decideReconcile(afterA, { seq: 1, result: 'NOT_FOUND' }, due).kind).toBe('NOOP');
    // Even once A's claim is due again, B's probe refers to the old generation.
    expect(decideReconcile(afterA, { seq: 1, result: 'NOT_FOUND' }, due + 5 * MIN).kind).toBe('PROBE_STALE');
    expect(afterA.dispatch.seq).toBe(2);
  });

  it('T11: a stalled recreate claimant cannot burn seq after another reconciler recreated the task', () => {
    const sim = new Sim().at(T0 + MIN);
    const a = sim.reconcile('NOT_FOUND');
    if (a.kind !== 'RECREATE_TASK') throw new Error(a.kind);
    // A stalls past its claim. B takes over, recreates the task and records it.
    sim.at(a.enqueue.claim);
    const b = sim.reconcile('NOT_FOUND');
    if (b.kind !== 'RECREATE_TASK') throw new Error(b.kind);
    expect(sim.enqueued(b.enqueue, { result: 'CREATED' }).kind).toBe('SCHEDULED');
    // A's createTask finally returns ALREADY_EXISTS (B's task). Without the claim it would look like a tombstone.
    expect(sim.enqueued(a.enqueue, { result: 'ALREADY_EXISTS' })).toMatchObject({ kind: 'NOOP', reason: 'CLAIM_LOST' });
    expect(sim.state.dispatch.seq).toBe(1);
  });

  it('T12: reconciler off and createTask failed → stays ACCEPTED and stuck, recovered once it runs', () => {
    const sim = new Sim();
    expect(isStuck(sim.state, T0 + 10 * MIN)).toBe(false);
    expect(isStuck(sim.state, T0 + 17 * MIN)).toBe(true);
    expect(sim.state.status).toBe('ACCEPTED');
    const d = sim.at(T0 + 17 * MIN).reconcile('NOT_FOUND');
    if (d.kind !== 'RECREATE_TASK') throw new Error(d.kind);
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

  it('B4 extra: a getTask PERMISSION_DENIED (UNKNOWN) changes no state besides the watchdog (ADR-011)', () => {
    const sim = new Sim();
    sim.complete(acquire(sim), TRANSIENT);
    const before = sim.state;
    const d = sim.at(before.watchdogAt as number).reconcile('UNKNOWN');
    expect(d.kind).toBe('PROBE_UNKNOWN');
    expect(sim.state).toEqual({ ...before, watchdogAt: sim.now + MIN });
  });

  it('T16 (P1): repeated losses end in DISPATCH_EXHAUSTED after MAX_DISPATCH generations', () => {
    const sim = new Sim();
    const outcomes: string[] = [];
    for (let i = 0; i < 5 && sim.state.status !== 'FAILED'; i++) {
      sim.complete(acquire(sim), TRANSIENT); // delivered, then the queue purges the task
      const d = sim.at(sim.state.watchdogAt as number).reconcile('NOT_FOUND');
      outcomes.push(d.kind);
      if (d.kind === 'REDISPATCH') sim.enqueued(d.enqueue, { result: 'CREATED' });
    }
    expect(outcomes).toEqual(['REDISPATCH', 'REDISPATCH', 'FAIL']);
    expect(sim.state).toMatchObject({ status: 'FAILED', statusReason: 'DISPATCH_EXHAUSTED', dispatch: { seq: 3 } });
  });
});
