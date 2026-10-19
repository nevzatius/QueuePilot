import { describe, expect, it } from 'vitest';
import {
  ATTENTION_REDISPATCH_MS,
  LEASE_GRACE_MS,
  LEASE_MS,
  MAX_ATTEMPTS,
  MAX_DISPATCH,
  PROBE_BACKOFF_CAP_MS,
  RETRY_WATCHDOG_MS,
  isStuck,
  needsAttention,
  type RequestState,
} from '../src/index.js';
import { MIN, S, T0, accepted } from './fixtures.js';
import { OK, TRANSIENT, Reconciler, World, Worker, deliverAndComplete, drain, pick, prng } from './model.js';

const HOUR = 60 * MIN;
/** Worst case from "infrastructure restored" to a terminal status when every actor is healthy. */
const RECOVERY_BOUND_MS = ATTENTION_REDISPATCH_MS + LEASE_MS + LEASE_GRACE_MS;

/** Upper bound on dispatch orders over `elapsed` ms without any delivery (prompt budget, then attention). */
const ordersBound = (elapsed: number) => MAX_DISPATCH - 1 + Math.ceil(elapsed / ATTENTION_REDISPATCH_MS);

/**
 * Undelivered request at `seq` whose task was never created (lost enqueues). `seq = 1` is the API's
 * order; `seq = MAX_DISPATCH` is the last prompt order, so the next one is an attention order.
 */
const lostEnqueue = (seq: number): RequestState => accepted({ dispatch: { seq }, watchdogAt: T0 });

const SEQS: Array<[string, number]> = [
  ['seq = 1', 1],
  ['seq = maxSeq', MAX_DISPATCH],
];

/**
 * The verified race (A2.2), replayed against ADR-017:
 * A's order expires, B takes over, B observes ALREADY_EXISTS and NOT_FOUND, the tombstone expires, A creates
 * its task late, then B commits its decision.
 */
function verifiedRace(seq: number, aWakesUp = true) {
  const w = new World(lostEnqueue(seq));
  const a = new Reconciler(w);
  const b = new Reconciler(w);
  // A probes `seq` (NOT_FOUND), commits its order seq+1 and stalls before createTask.
  expect(a.pass()).toMatchObject({ kind: 'DISPATCH', enqueue: { seq: seq + 1 } });
  // A's order expires: the watchdog it committed is due.
  w.until(w.state.watchdogAt);
  // B takes over. A never created seq+1, so B's probe is NOT_FOUND too, and B orders seq+2.
  expect(b.pass()).toMatchObject({ kind: 'DISPATCH', enqueue: { seq: seq + 2 } });
  // B's createTask answers ALREADY_EXISTS (its own earlier call created the name, which is gone since) and
  // a getTask answers NOT_FOUND.
  w.queue.tombstone(seq + 2);
  const outcome = b.create();
  expect(outcome).toEqual({ result: 'ALREADY_EXISTS' });
  expect(w.queue.get(seq + 2)).toBe('NOT_FOUND');
  // The tombstone expires. Then A wakes up and creates its task late.
  w.queue.forgetTombstones();
  if (aWakesUp) expect(a.create()).toEqual({ result: 'CREATED' });
  return { w, a, b, outcome };
}

describe('A2.2 verified race: a late createTask after a takeover', () => {
  it.each(SEQS)('%s: B commits without effect, A\'s late task processes the request, nothing fails', (_name, seq) => {
    const { w, a, b, outcome } = verifiedRace(seq);
    const before = w.state;
    // B commits its decision: ALREADY_EXISTS on its own name is CREATED, so there is nothing to record.
    expect(b.record(outcome)).toMatchObject({ kind: 'NOOP', reason: 'UNCHANGED' });
    expect(w.state).toBe(before);
    expect(w.state).toMatchObject({ status: 'ACCEPTED', statusReason: null, dispatch: { seq: seq + 2 }, processing: { attempts: 0 } });
    expect(needsAttention(w.state)).toBe(seq === MAX_DISPATCH);

    // A's late task belongs to an older order and is still processed normally.
    expect(deliverAndComplete(w, seq + 1)).toBe('COMPLETE');
    expect(w.state).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 }, dispatch: { attentionSince: null } });
    expect(a.record()).toMatchObject({ kind: 'NOOP', reason: 'TERMINAL' });

    // Two orders, one per actor, each with its own name. Budgets were not touched by the race.
    const attention = seq === MAX_DISPATCH;
    expect(w.orders.map((o) => [o.seq, o.attention])).toEqual([
      [seq + 1, attention],
      [seq + 2, attention],
    ]);
    expect(w.events.filter((e) => e.type === 'FAILED')).toEqual([]);
    expect(w.events.filter((e) => e.type === 'REDISPATCHED').map((e) => e.id)).toEqual(
      attention ? [`REDISPATCHED-s${seq + 1}`] : [`REDISPATCHED-s${seq + 1}`, `REDISPATCHED-s${seq + 2}`],
    );
    w.checkDispatchRate();
  });

  it.each(SEQS)('%s: if A never wakes up, the next due pass dispatches again and the request completes', (_name, seq) => {
    const { w, b, outcome } = verifiedRace(seq, false);
    b.record(outcome);
    expect(w.queue.live()).toEqual([]);
    expect(drain(w)).toBeLessThanOrEqual(RECOVERY_BOUND_MS);
    expect(w.state).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 }, dispatch: { seq: seq + 3 } });
    w.checkDispatchRate();
  });

  it.each(SEQS)('%s: every interleaving of A, B, the tombstone, a worker and a third reconciler is safe and live', (_name, seq) => {
    type Step = 'aCreate' | 'aRecord' | 'bCreate' | 'bRecord' | 'expire' | 'worker' | 'reconcile';
    const steps: Step[] = ['aCreate', 'aRecord', 'bCreate', 'bRecord', 'expire', 'worker', 'reconcile'];
    const before: Partial<Record<Step, Step>> = { aRecord: 'aCreate', bRecord: 'bCreate' };
    const orders: Step[][] = [];
    const permute = (prefix: Step[], rest: Step[]) => {
      if (rest.length === 0) orders.push(prefix);
      for (const s of rest) {
        const dep = before[s];
        if (dep !== undefined && !prefix.includes(dep)) continue;
        permute([...prefix, s], rest.filter((x) => x !== s));
      }
    };
    permute([], steps);
    expect(orders).toHaveLength(1260);

    for (const tombstoned of [false, true]) {
      for (const order of orders) {
        const label = `tombstoned=${tombstoned}: ${order.join(' → ')}`;
        const w = new World(lostEnqueue(seq));
        const a = new Reconciler(w);
        const b = new Reconciler(w);
        a.pass();
        w.until(w.state.watchdogAt);
        b.pass();
        if (tombstoned) w.queue.tombstone(seq + 2);
        for (const step of order) {
          if (step === 'aCreate') a.create();
          if (step === 'aRecord') a.record();
          if (step === 'bCreate') b.create();
          if (step === 'bRecord') b.record();
          if (step === 'expire') w.queue.forgetTombstones();
          if (step === 'worker') for (const s of w.queue.live()) deliverAndComplete(w, s);
          if (step === 'reconcile') {
            w.until(w.state.watchdogAt);
            new Reconciler(w).fullPass();
          }
        }
        expect(drain(w), label).toBeLessThanOrEqual(RECOVERY_BOUND_MS);
        expect(w.state.status, label).toBe('COMPLETED');
        expect(w.state.processing.attempts, label).toBe(1);
        w.checkDispatchRate();
      }
    }
  });
});

describe('delayed side effects and duplicate delivery', () => {
  it('the API\'s createTask for seq 1 lands after the reconciler ordered seq 2: one start, one suppressed duplicate', () => {
    const w = World.accepted();
    w.until(w.state.watchdogAt);
    expect(new Reconciler(w).fullPass()).toMatchObject({ kind: 'DISPATCH', enqueue: { seq: 2 }, attention: false });
    w.queue.create(1); // the API's createTask, late
    expect(w.queue.live().sort()).toEqual([1, 2]);
    // The older task arrives first and does the work; the newer one is absorbed.
    expect(deliverAndComplete(w, 1)).toBe('COMPLETE');
    expect(new Worker(w).deliver(2)).toMatchObject({ kind: 'DUPLICATE_SUPPRESSED', http: 200 });
    expect(w.state).toMatchObject({
      status: 'COMPLETED',
      processing: { attempts: 1, duplicateDeliveries: 1 },
      dispatch: { seq: 2, deliveredSeq: 1 },
    });
  });

  it('two deliveries in flight at once: one lease, one 409; the retry after completion gets 200', () => {
    const w = World.accepted();
    w.queue.create(1);
    const w1 = new Worker(w, 'W1');
    const w2 = new Worker(w, 'W2');
    expect(w1.deliver(1).kind).toBe('ACQUIRE_LEASE');
    expect(w2.deliver(1)).toMatchObject({ kind: 'LEASE_HELD', http: 409 });
    expect(w1.complete(OK).kind).toBe('COMPLETE');
    expect(w2.deliver(1)).toMatchObject({ kind: 'DUPLICATE_SUPPRESSED', http: 200 });
    expect(w.state.processing).toMatchObject({ attempts: 1, duplicateDeliveries: 1 });
  });

  it('tasks of two orders delivered concurrently: the second waits on the lease, then is suppressed', () => {
    const w = new World(lostEnqueue(1));
    new Reconciler(w).fullPass();
    w.queue.create(1);
    const w1 = new Worker(w, 'W1');
    const w2 = new Worker(w, 'W2');
    expect(w1.deliver(2).kind).toBe('ACQUIRE_LEASE');
    expect(w2.deliver(1).kind).toBe('LEASE_HELD');
    w1.complete(OK);
    expect(w2.deliver(1).kind).toBe('DUPLICATE_SUPPRESSED');
    expect(w.state.processing.attempts).toBe(1);
  });
});

describe('worker crashes', () => {
  it('crash after the lease, then the queue gives up on the task: a fresh order and a takeover complete it', () => {
    const w = World.accepted();
    w.queue.create(1);
    const crashed = new Worker(w, 'W1');
    expect(crashed.deliver(1).kind).toBe('ACQUIRE_LEASE');
    crashed.crash();
    w.queue.remove(1); // retries exhausted on the queue side
    w.until(w.state.watchdogAt); // lease expiry + 30 s
    expect(new Reconciler(w).fullPass()).toMatchObject({ kind: 'DISPATCH', enqueue: { seq: 2 }, attention: false });
    const d = new Worker(w, 'W2').deliver(2);
    expect(d).toMatchObject({ kind: 'ACQUIRE_LEASE', takeover: true });
    expect(w.state.processing.attempts).toBe(2);
  });

  it('a crash on every attempt fails only once MAX_ATTEMPTS business starts happened (I5), never earlier', () => {
    const w = World.accepted();
    w.queue.create(1);
    const statuses: string[] = [];
    for (let i = 0; i < 2 * MAX_ATTEMPTS && w.state.status !== 'FAILED'; i++) {
      const worker = new Worker(w, `W${i}`);
      const d = worker.deliver(1); // the queue retries the same live task
      statuses.push(d.kind);
      worker.crash();
      w.advance(LEASE_MS);
    }
    expect(statuses).toEqual([...Array<string>(MAX_ATTEMPTS).fill('ACQUIRE_LEASE'), 'FAIL']);
    expect(w.state).toMatchObject({ status: 'FAILED', statusReason: 'ATTEMPTS_EXHAUSTED', processing: { attempts: MAX_ATTEMPTS } });
  });

  it('a reconciler that crashes between its order and createTask loses nothing: the order is durable', () => {
    const w = World.accepted(); // the API's createTask was lost
    w.until(w.state.watchdogAt);
    const a = new Reconciler(w);
    expect(a.pass()).toMatchObject({ kind: 'DISPATCH', enqueue: { seq: 2 } });
    a.crash();
    expect(w.state.watchdogAt).toBe(w.now + RETRY_WATCHDOG_MS);
    w.until(w.state.watchdogAt);
    expect(new Reconciler(w).fullPass()).toMatchObject({ kind: 'DISPATCH', enqueue: { seq: 3 } });
    expect(deliverAndComplete(w, 3)).toBe('COMPLETE');
  });
});

describe('queue creation failure and recovery after restoration', () => {
  function outage(until: number) {
    const w = World.accepted();
    w.queue.outage = true;
    expect(w.queue.create(1).result).toBe('FAILED'); // the API's createTask (logged only)
    const r = new Reconciler(w);
    while ((w.state.watchdogAt as number) <= until) {
      w.until(w.state.watchdogAt);
      r.fullPass();
    }
    return w;
  }

  it('a 3 h outage: no task, bounded orders, attention instead of FAILED', () => {
    const w = outage(T0 + 3 * HOUR);
    expect(w.queue.created).toBe(0);
    expect(w.orders.map((o) => (o.at - T0) / MIN)).toEqual([1, 6, 11, 41, 71, 101, 131, 161]);
    expect(w.orders.map((o) => o.attention)).toEqual([false, false, true, true, true, true, true, true]);
    expect(w.state).toMatchObject({
      status: 'ACCEPTED',
      statusReason: null,
      dispatch: { seq: 9, attentionSince: T0 + 11 * MIN, lastError: { code: 'UNAVAILABLE' } },
    });
    expect(needsAttention(w.state)).toBe(true);
    expect(isStuck(w.state, w.now)).toBe(false); // the reconciler is running; attention is the signal
    // The timeline records entering attention once, not every 30 minutes.
    expect(w.events.map((e) => e.id)).toEqual(['ACCEPTED-s1', 'REDISPATCHED-s2', 'REDISPATCHED-s3', 'REDISPATCHED-s4']);
    w.checkDispatchRate();
  });

  it('recovery after restoration takes at most one attention interval and clears attention', () => {
    const w = outage(T0 + 3 * HOUR);
    expect(drain(w)).toBeLessThanOrEqual(ATTENTION_REDISPATCH_MS);
    expect(w.state).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 }, dispatch: { attentionSince: null } });
    expect(w.queue.created).toBe(1);
  });

  it('a 24 h outage stays within the order bound and creates no task', () => {
    const w = outage(T0 + 24 * HOUR);
    expect(w.orders.length).toBeLessThanOrEqual(ordersBound(24 * HOUR));
    expect(w.queue.created).toBe(0);
    expect(w.state.status).toBe('ACCEPTED');
    expect(drain(w)).toBeLessThanOrEqual(ATTENTION_REDISPATCH_MS);
  });

  it('createTask failures are recorded for operators; the next success clears them', () => {
    const w = World.accepted();
    w.until(w.state.watchdogAt);
    w.queue.outage = true;
    new Reconciler(w).fullPass();
    expect(w.state.dispatch.lastError).toMatchObject({ code: 'UNAVAILABLE', at: w.now });
    w.queue.outage = false;
    w.until(w.state.watchdogAt);
    new Reconciler(w).fullPass();
    expect(w.state.dispatch.lastError).toBeNull();
  });
});

describe('bounded retries and backpressure', () => {
  it('a queue paused for 6 h with a live task: no new orders, probes back off to 15 min, completes on resume', () => {
    const w = World.accepted();
    w.queue.create(1);
    const r = new Reconciler(w);
    const passes: number[] = [];
    while ((w.state.watchdogAt as number) <= T0 + 6 * HOUR) {
      w.until(w.state.watchdogAt);
      passes.push(w.now);
      expect(r.fullPass().kind).toBe('WAIT_FOR_TASK');
    }
    expect(w.orders).toEqual([]);
    expect(w.state.dispatch.seq).toBe(1);
    const gaps = passes.slice(1).map((t, i) => t - (passes[i] as number));
    expect(gaps.slice(0, 4).map((g) => g / MIN)).toEqual([2, 4, 8, 15]);
    expect(new Set(gaps.slice(4))).toEqual(new Set([PROBE_BACKOFF_CAP_MS]));
    expect(deliverAndComplete(w, 1)).toBe('COMPLETE');
  });

  it('a getTask that always errors (UNKNOWN) cannot amplify tasks beyond the order bound', () => {
    const w = World.accepted();
    w.queue.create(1);
    w.queue.probeOverride = 'UNKNOWN';
    const r = new Reconciler(w);
    while ((w.state.watchdogAt as number) <= T0 + 6 * HOUR) {
      w.until(w.state.watchdogAt);
      r.fullPass();
    }
    expect(w.queue.created).toBeLessThanOrEqual(1 + ordersBound(6 * HOUR));
    w.checkDispatchRate();
    // Every one of those tasks is absorbed: exactly one business start.
    for (const seq of w.queue.live()) deliverAndComplete(w, seq);
    expect(w.state).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 } });
    expect(w.state.processing.duplicateDeliveries).toBe(w.queue.created - 1);
  });

  it('tasks that keep vanishing undelivered are re-dispatched at the bounded cadence, never failed', () => {
    const w = World.accepted();
    const r = new Reconciler(w);
    while ((w.state.watchdogAt as number) <= T0 + 6 * HOUR) {
      w.until(w.state.watchdogAt);
      r.fullPass();
      for (const seq of w.queue.live()) w.queue.remove(seq); // purged before delivery
    }
    expect(w.orders.length).toBeLessThanOrEqual(ordersBound(6 * HOUR));
    expect(w.state).toMatchObject({ status: 'ACCEPTED', statusReason: null });
    expect(needsAttention(w.state)).toBe(true);
    w.checkDispatchRate();
    expect(drain(w)).toBeLessThanOrEqual(RECOVERY_BOUND_MS);
    expect(w.state.status).toBe('COMPLETED');
  });
});

describe('arbitrary scheduling (seeded fuzz)', () => {
  /**
   * Two reconcilers, two workers, a stalled creator of the starting `seq`, and a chaotic queue (outages,
   * lying getTask, drops, tombstone expiry), interleaved at random for 150 steps. Every commit is checked
   * by `World.checkSafety`. Afterwards the infrastructure is restored and the run must end terminal within
   * the recovery bound, and the stalled actors' late side effects must change nothing.
   */
  function run(seed: number, startSeq: number): RequestState {
    const rnd = prng(seed);
    const w = new World(lostEnqueue(startSeq));
    const reconcilers = [new Reconciler(w), new Reconciler(w)];
    const workers = [new Worker(w, 'W1'), new Worker(w, 'W2')];
    let lateCreate = true;
    for (let step = 0; step < 150; step++) {
      const live = w.queue.live();
      const actions: Array<() => unknown> = [
        () => w.advance(pick(rnd, [S, 20 * S, MIN, 5 * MIN, 31 * MIN])),
        () => w.until(w.state.watchdogAt),
        () => w.queue.forgetTombstones(),
        () => {
          w.queue.outage = !w.queue.outage;
        },
        () => {
          w.queue.probeOverride = pick(rnd, [null, 'EXISTS', 'NOT_FOUND', 'UNKNOWN'] as const);
        },
      ];
      for (const r of reconcilers) {
        if (r.stage === 'IDLE') actions.push(() => r.plan());
        if (r.stage === 'PROBED') actions.push(() => r.decide());
        if (r.stage === 'ORDERED') actions.push(() => r.create());
        if (r.stage === 'CREATED') actions.push(() => r.record());
        if (r.stage !== 'IDLE') actions.push(() => r.crash());
      }
      for (const wk of workers) {
        if (wk.lease === null && live.length > 0) actions.push(() => wk.deliver(pick(rnd, live)));
        if (wk.lease !== null) actions.push(() => wk.complete(OK), () => wk.complete(TRANSIENT), () => wk.crash());
      }
      if (live.length > 0) actions.push(() => w.queue.remove(pick(rnd, live)));
      if (lateCreate) {
        actions.push(() => {
          lateCreate = false;
          w.queue.create(startSeq);
        });
      }
      pick(rnd, actions)();
    }

    expect(drain(w), `seed ${seed}`).toBeLessThanOrEqual(RECOVERY_BOUND_MS);
    w.checkDispatchRate();

    // Late side effects of every stalled actor, after the request settled.
    const settled = w.state;
    if (lateCreate) w.queue.create(startSeq);
    for (const r of reconcilers) {
      if (r.stage === 'PROBED') r.decide();
      if (r.stage === 'ORDERED') r.create();
      if (r.stage === 'CREATED') r.record();
    }
    for (const wk of workers) if (wk.lease !== null) wk.complete(OK);
    for (const seq of w.queue.live()) deliverAndComplete(w, seq);
    const bookkeeping = (s: RequestState) => ({ ...s, processing: { ...s.processing, duplicateDeliveries: 0 } });
    expect(bookkeeping(w.state), `seed ${seed}`).toEqual(bookkeeping(settled));
    return w.state;
  }

  it.each(SEQS)('%s: 400 random schedules end COMPLETED, or FAILED only after MAX_ATTEMPTS starts', (_name, seq) => {
    const outcomes = { COMPLETED: 0, FAILED: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      const end = run(seed * 7919 + seq, seq);
      if (end.status === 'FAILED') {
        expect(end).toMatchObject({ statusReason: 'ATTEMPTS_EXHAUSTED', processing: { attempts: MAX_ATTEMPTS } });
        outcomes.FAILED++;
      } else {
        expect(end.status).toBe('COMPLETED');
        outcomes.COMPLETED++;
      }
    }
    // Sanity: the fuzz explores both legitimate endings, and mostly completes.
    expect(outcomes.COMPLETED).toBeGreaterThan(outcomes.FAILED);
  });
});
