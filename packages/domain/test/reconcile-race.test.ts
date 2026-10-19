import { describe, expect, it } from 'vitest';
import {
  MAX_DISPATCH,
  SHORT_RECHECK_MS,
  decideCompletion,
  decideDelivery,
  decideEnqueueResult,
  decideReconcile,
  decideVerifyResult,
  type DomainEvent,
  type EnqueueDecision,
  type EnqueueOrder,
  type EnqueueOutcome,
  type ProbeResult,
  type ProcessingOutcome,
  type ReconcileDecision,
  type RequestState,
  type StateWrite,
  type VerifyDecision,
} from '../src/index.js';
import { MIN, T0, accepted, apply } from './fixtures.js';

/**
 * Concurrent reconcilers against a fake queue. Firestore is modelled as one serialised state: every
 * decision reads the current state and commits immediately, as a transaction would. Queue calls are
 * side effects that no claim can fence, so a stalled actor may still perform them late.
 */
class FakeQueue {
  /** `LIVE` until delivered successfully or deleted; then the name stays taken (`TOMBSTONE`). */
  private readonly names = new Map<number, 'LIVE' | 'TOMBSTONE'>();
  create(seq: number): EnqueueOutcome {
    if (this.names.has(seq)) return { result: 'ALREADY_EXISTS' };
    this.names.set(seq, 'LIVE');
    return { result: 'CREATED' };
  }
  get(seq: number): ProbeResult {
    return this.names.get(seq) === 'LIVE' ? 'EXISTS' : 'NOT_FOUND';
  }
  /** The task finished (2xx) or the queue deleted it. */
  remove(seq: number): void {
    this.names.set(seq, 'TOMBSTONE');
  }
  isLive(seq: number): boolean {
    return this.names.get(seq) === 'LIVE';
  }
}

class World {
  readonly queue = new FakeQueue();
  readonly events: DomainEvent[] = [];
  now = T0;
  constructor(public state: RequestState) {}
  commit(write: StateWrite | null): void {
    if (write === null) return;
    this.state = apply(this.state, write);
    this.events.push(...write.events);
  }
  at(t: number): this {
    this.now = t;
    return this;
  }
}

/** One reconciler instance, driven step by step through the adapter flow in `reconcile.ts`. */
class Reconciler {
  order: EnqueueOrder | null = null;
  constructor(private readonly w: World) {}

  /** Steps 1-2: plain read, getTask, then the transactional decision. Keeps the order on a claim. */
  claim(probe: ProbeResult = this.w.queue.get(this.w.state.dispatch.seq)): ReconcileDecision {
    const plan = decideReconcile(this.w.state, null, this.w.now);
    const d = plan.kind === 'PROBE_TASK' ? decideReconcile(this.w.state, { seq: plan.seq, result: probe }, this.w.now) : plan;
    this.w.commit(d.write);
    if (d.kind === 'RECREATE_TASK' || d.kind === 'REDISPATCH') this.order = d.enqueue;
    return d;
  }
  /** Step 3, first half: the unfenced side effect. */
  create(): EnqueueOutcome {
    return this.w.queue.create(this.requireOrder().seq);
  }
  /** Step 3, second half. */
  interpret(outcome: EnqueueOutcome): EnqueueDecision {
    const d = decideEnqueueResult(this.w.state, this.requireOrder(), outcome, this.w.now);
    this.w.commit(d.write);
    return d;
  }
  /** Step 4: re-probe after ALREADY_EXISTS, then the transactional decision. */
  verify(probe: ProbeResult = this.w.queue.get(this.requireOrder().seq)): VerifyDecision {
    const order = this.requireOrder();
    const d = decideVerifyResult(this.w.state, order, { seq: order.seq, result: probe }, this.w.now);
    this.w.commit(d.write);
    if (d.kind === 'REDISPATCH') this.order = d.enqueue;
    return d;
  }
  private requireOrder(): EnqueueOrder {
    if (this.order === null) throw new Error('no enqueue order');
    return this.order;
  }
}

const OK: ProcessingOutcome = {
  kind: 'SUCCESS',
  result: { rulesVersion: 'triage-v1', lane: 'standard', slaTargetMinutes: 90, team: 'roadside-urban', score: 35 },
};

/** A worker delivery of `seq` that runs to completion and acknowledges the task. */
function deliverAndComplete(w: World, seq: number, leaseId = 'L1') {
  const d = decideDelivery(w.state, { seq, leaseId }, w.now);
  w.commit(d.write);
  if (d.kind !== 'ACQUIRE_LEASE') return d.kind;
  const c = decideCompletion(w.state, leaseId, OK, w.now);
  w.commit(c.write);
  w.queue.remove(seq);
  return c.kind;
}

/**
 * Undelivered request at `seq` whose task was never created (e.g. createTask failed after S1 or S9).
 * `seq = 1` is the first generation; `seq = MAX_DISPATCH` is the last one the budget allows.
 */
function lostEnqueue(seq: number): World {
  return new World(accepted({ processing: { attempts: seq - 1 }, dispatch: { seq, deliveredSeq: seq - 1 }, watchdogAt: T0 }));
}

/**
 * The reported race: A claims NOT_FOUND and stalls, its claim expires, B claims NOT_FOUND, A creates the
 * task late and crashes, and B's createTask answers ALREADY_EXISTS.
 */
function raceToAlreadyExists(seq: number) {
  const w = lostEnqueue(seq);
  const a = new Reconciler(w);
  const b = new Reconciler(w);
  expect(a.claim().kind).toBe('RECREATE_TASK');
  w.at(a.order!.claim); // A stalls until its claim is due
  expect(b.claim().kind).toBe('RECREATE_TASK');
  expect(b.order!.claim).toBeGreaterThan(a.order!.claim);
  expect(a.create()).toEqual({ result: 'CREATED' }); // A's late side effect; A crashes before interpreting it
  const outcome = b.create();
  expect(outcome).toEqual({ result: 'ALREADY_EXISTS' });
  expect(b.interpret(outcome).kind).toBe('VERIFY_TASK');
  return { w, a, b };
}

const SEQS: Array<[string, number]> = [
  ['seq = 1', 1],
  ['seq = maxSeq', MAX_DISPATCH],
];

describe('reconciler race: a stalled claimant creates the task late (A2.1)', () => {
  it.each(SEQS)('%s: B re-probes EXISTS and waits; no seq++, no FAILED, the live task completes', (_name, seq) => {
    const { w, b } = raceToAlreadyExists(seq);
    const before = w.state;
    const v = b.verify();
    expect(v.kind).toBe('WAIT_FOR_TASK');
    expect(w.state).toMatchObject({ status: 'ACCEPTED', statusReason: null, dispatch: { seq, checks: 1 } });
    expect(w.state.watchdogAt).toBe(w.now + 2 * MIN);
    expect(w.events).toEqual([]);
    expect(before.dispatch.seq).toBe(seq);

    // The task A created is still the current generation and is processed normally.
    expect(deliverAndComplete(w, seq)).toBe('COMPLETE');
    expect(w.state).toMatchObject({ status: 'COMPLETED', dispatch: { seq } });
  });

  it.each(SEQS)('%s: post-ALREADY_EXISTS UNKNOWN changes only the watchdog and retries in 1 minute', (_name, seq) => {
    const { w, b } = raceToAlreadyExists(seq);
    const before = w.state;
    expect(b.verify('UNKNOWN').kind).toBe('PROBE_UNKNOWN');
    expect(w.state).toEqual({ ...before, watchdogAt: w.now + SHORT_RECHECK_MS });
    // The next pass finds A's live task.
    w.at(w.now + SHORT_RECHECK_MS);
    expect(new Reconciler(w).claim().kind).toBe('WAIT_FOR_TASK');
    expect(w.state.dispatch.seq).toBe(seq);
  });

  it.each(SEQS)('%s: post-ALREADY_EXISTS NOT_FOUND after the live task completed is fenced by the fresh read', (_name, seq) => {
    const { w, b } = raceToAlreadyExists(seq);
    expect(deliverAndComplete(w, seq)).toBe('COMPLETE'); // A's task runs between B's createTask and B's probe
    expect(b.verify()).toMatchObject({ kind: 'NOOP', reason: 'TERMINAL' });
    expect(w.state).toMatchObject({ status: 'COMPLETED', dispatch: { seq } });
  });

  it.each(SEQS)('%s: a lease taken between ALREADY_EXISTS and the probe fences B', (_name, seq) => {
    const { w, b } = raceToAlreadyExists(seq);
    const d = decideDelivery(w.state, { seq, leaseId: 'L1' }, w.now);
    w.commit(d.write);
    expect(d.kind).toBe('ACQUIRE_LEASE');
    expect(b.verify()).toMatchObject({ kind: 'NOOP', reason: 'CLAIM_LOST' });
    expect(w.state).toMatchObject({ status: 'PROCESSING', dispatch: { seq } });
  });

  it('the stalled claimant that wakes up later cannot interpret its own CREATED', () => {
    const { w, a, b } = raceToAlreadyExists(1);
    b.verify();
    expect(a.interpret({ result: 'CREATED' })).toMatchObject({ kind: 'NOOP', reason: 'CLAIM_LOST' });
    expect(w.state.dispatch.seq).toBe(1);
  });
});

describe('reconciler race: genuinely lost tasks are still recovered', () => {
  /** The task was created, then deleted by the queue before any lease commit (pre-lease failures). */
  function tombstoned(seq: number) {
    const w = lostEnqueue(seq);
    w.queue.create(seq);
    w.queue.remove(seq);
    const r = new Reconciler(w);
    expect(r.claim().kind).toBe('RECREATE_TASK');
    const outcome = r.create();
    expect(outcome).toEqual({ result: 'ALREADY_EXISTS' });
    expect(r.interpret(outcome).kind).toBe('VERIFY_TASK');
    return { w, r };
  }

  it('seq = 1: ALREADY_EXISTS then NOT_FOUND under the current claim proves the tombstone → seq 2 completes', () => {
    const { w, r } = tombstoned(1);
    const v = r.verify();
    expect(v.kind).toBe('REDISPATCH');
    expect(w.events.map((e) => [e.id, e.details])).toEqual([['REDISPATCHED-s2', { reason: 'TOMBSTONE' }]]);
    expect(r.interpret(r.create()).kind).toBe('SCHEDULED');
    expect(deliverAndComplete(w, 2)).toBe('COMPLETE');
    expect(w.state).toMatchObject({ status: 'COMPLETED', dispatch: { seq: 2 } });
  });

  it('seq = maxSeq: a proven tombstone ends in DISPATCH_EXHAUSTED', () => {
    const { w, r } = tombstoned(MAX_DISPATCH);
    expect(r.verify()).toMatchObject({ kind: 'FAIL', reason: 'DISPATCH_EXHAUSTED' });
    expect(w.state).toMatchObject({ status: 'FAILED', statusReason: 'DISPATCH_EXHAUSTED', watchdogAt: null });
  });

  it('a delivered task that disappears is still redispatched by step 6 without any ALREADY_EXISTS', () => {
    const w = new World(accepted({ processing: { attempts: 1 }, dispatch: { seq: 1, deliveredSeq: 1 } }));
    expect(new Reconciler(w).claim('NOT_FOUND').kind).toBe('REDISPATCH');
    expect(w.state.dispatch.seq).toBe(2);
  });
});

describe('reconciler race: expired claims and stale results', () => {
  it('B stalls during the verify probe; C takes over; B\'s late NOT_FOUND is discarded', () => {
    const { w, b } = raceToAlreadyExists(1);
    w.at(b.order!.claim); // B's claim is due; C finds A's live task
    const c = new Reconciler(w);
    expect(c.claim().kind).toBe('WAIT_FOR_TASK');
    expect(b.verify('NOT_FOUND')).toMatchObject({ kind: 'NOOP', reason: 'CLAIM_LOST' });
    expect(w.state.dispatch.seq).toBe(1);
  });

  it('a probe answer for another seq is discarded', () => {
    const { w, b } = raceToAlreadyExists(1);
    const d = decideVerifyResult(w.state, b.order!, { seq: 2, result: 'NOT_FOUND' }, w.now);
    expect(d).toMatchObject({ kind: 'NOOP', reason: 'STALE_SEQ' });
  });

  it('after a proven tombstone, the older generation\'s claimant and its late task are both stale', () => {
    const w = lostEnqueue(1);
    w.queue.create(1);
    w.queue.remove(1);
    const a = new Reconciler(w);
    const b = new Reconciler(w);
    a.claim();
    w.at(a.order!.claim);
    b.claim();
    expect(b.interpret(b.create()).kind).toBe('VERIFY_TASK');
    expect(b.verify().kind).toBe('REDISPATCH');
    const stale: EnqueueOrder = a.order!;
    expect(a.interpret(a.create())).toMatchObject({ kind: 'NOOP', reason: 'STALE_SEQ' });
    expect(decideVerifyResult(w.state, stale, { seq: 1, result: 'NOT_FOUND' }, w.now)).toMatchObject({
      kind: 'NOOP',
      reason: 'STALE_SEQ',
    });
    expect(decideDelivery(w.state, { seq: 1, leaseId: 'old' }, w.now).kind).toBe('STALE_DISPATCH');
    expect(w.state.dispatch.seq).toBe(2);
  });

  it('two stalled claimants of one generation increment seq at most once', () => {
    const w = lostEnqueue(1);
    w.queue.create(1);
    w.queue.remove(1);
    const a = new Reconciler(w);
    const b = new Reconciler(w);
    a.claim();
    w.at(a.order!.claim);
    b.claim();
    const aOutcome = a.create();
    const bOutcome = b.create();
    expect(a.interpret(aOutcome)).toMatchObject({ kind: 'NOOP', reason: 'CLAIM_LOST' });
    expect(b.interpret(bOutcome).kind).toBe('VERIFY_TASK');
    expect(b.verify().kind).toBe('REDISPATCH');
    expect(w.state.dispatch.seq).toBe(2);
    expect(w.events.filter((e) => e.type === 'REDISPATCHED')).toHaveLength(1);
  });
});

describe('reconciler race: concurrent completion and reconcile', () => {
  it('a completion between B\'s claim and B\'s createTask result ends B\'s flow without a write', () => {
    const w = lostEnqueue(1);
    const a = new Reconciler(w);
    const b = new Reconciler(w);
    a.claim();
    w.at(a.order!.claim);
    b.claim();
    a.create();
    expect(deliverAndComplete(w, 1)).toBe('COMPLETE');
    const after = w.state;
    expect(b.interpret(b.create())).toMatchObject({ kind: 'NOOP', reason: 'TERMINAL' });
    expect(w.state).toBe(after);
  });

  it('a reconciler that sees the completed request only clears its watchdog', () => {
    const w = lostEnqueue(1);
    const r = new Reconciler(w);
    r.claim();
    expect(r.interpret(r.create()).kind).toBe('SCHEDULED');
    expect(deliverAndComplete(w, 1)).toBe('COMPLETE');
    expect(new Reconciler(w).claim('NOT_FOUND')).toMatchObject({ kind: 'NOOP', reason: 'ALREADY_CLEAN' });
    expect(w.state.status).toBe('COMPLETED');
  });

  it('the live task stays the only processed generation under any interleaving of A, B and the worker', () => {
    // Exhaustive over the order of A's late create, B's create, B's interpret, the worker run and B's verify.
    type Step = 'aCreate' | 'bCreate' | 'worker';
    const orders: Step[][] = [
      ['aCreate', 'bCreate', 'worker'],
      ['aCreate', 'worker', 'bCreate'],
      ['bCreate', 'aCreate', 'worker'],
      ['bCreate', 'worker', 'aCreate'],
      ['worker', 'aCreate', 'bCreate'],
      ['worker', 'bCreate', 'aCreate'],
    ];
    for (const seq of [1, MAX_DISPATCH]) {
      for (const steps of orders) {
        const w = lostEnqueue(seq);
        const a = new Reconciler(w);
        const b = new Reconciler(w);
        a.claim();
        w.at(a.order!.claim);
        b.claim();
        let bOutcome: EnqueueOutcome | null = null;
        for (const step of steps) {
          if (step === 'aCreate') a.create();
          if (step === 'bCreate') bOutcome = b.create();
          if (step === 'worker' && w.queue.isLive(seq)) deliverAndComplete(w, seq);
        }
        const e = b.interpret(bOutcome!);
        if (e.kind === 'VERIFY_TASK') b.verify();
        if (w.queue.isLive(seq)) deliverAndComplete(w, seq, 'L2');
        const label = `seq ${seq}, ${steps.join(' → ')}`;
        expect(w.state.dispatch.seq, label).toBe(seq);
        expect(w.state.status, label).toBe('COMPLETED');
        expect(w.events.filter((ev) => ev.type === 'PROCESSING_STARTED'), label).toHaveLength(1);
      }
    }
  });
});
