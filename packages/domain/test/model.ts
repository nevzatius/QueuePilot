import { expect } from 'vitest';
import {
  ATTENTION_REDISPATCH_MS,
  RETRY_WATCHDOG_MS,
  decideCompletion,
  decideDelivery,
  decideEnqueueResult,
  decideReconcile,
  isTerminal,
  planAcceptance,
  type CompletionDecision,
  type DeliveryDecision,
  type DomainEvent,
  type EnqueueDecision,
  type EnqueueOrder,
  type EnqueueOutcome,
  type ProbeResult,
  type ProcessingOutcome,
  type ReconcileDecision,
  type RequestState,
  type StateWrite,
  type TaskProbe,
} from '../src/index.js';
import { T0, apply } from './fixtures.js';

/*
 * A model of Firestore, Cloud Tasks, reconcilers and workers for ADR-017.
 *
 * Firestore is one serialised state: every decision reads the current state and commits at once, as a
 * transaction would. Queue calls are side effects that no transaction fences, so a stalled actor may
 * perform them arbitrarily late. Every commit is checked against the safety properties in `commit`.
 */

export const OK: ProcessingOutcome = {
  kind: 'SUCCESS',
  result: { rulesVersion: 'triage-v1', lane: 'standard', slaTargetMinutes: 90, team: 'roadside-urban', score: 35 },
};
export const TRANSIENT: ProcessingOutcome = { kind: 'TRANSIENT_ERROR', error: { code: 'TIMEOUT', message: 'timeout' } };

/** Cloud Tasks double. A name is LIVE until acknowledged or dropped, then a TOMBSTONE until forgotten. */
export class FakeQueue {
  private readonly names = new Map<number, 'LIVE' | 'TOMBSTONE'>();
  /** Tasks actually created. */
  created = 0;
  /** createTask fails and creates nothing (queue missing, IAM broken, region outage). */
  outage = false;
  /** getTask answers this instead of the truth: stale reads, errors, or a lying cache. */
  probeOverride: ProbeResult | null = null;

  create(seq: number): EnqueueOutcome {
    if (this.outage) return { result: 'FAILED', error: { code: 'UNAVAILABLE', message: 'queue unavailable' } };
    if (this.names.has(seq)) return { result: 'ALREADY_EXISTS' };
    this.names.set(seq, 'LIVE');
    this.created++;
    return { result: 'CREATED' };
  }
  get(seq: number): ProbeResult {
    return this.probeOverride ?? (this.names.get(seq) === 'LIVE' ? 'EXISTS' : 'NOT_FOUND');
  }
  /** Acknowledged with 2xx, or deleted once the queue's own retries ran out. The name stays taken. */
  remove(seq: number): void {
    if (this.names.has(seq)) this.names.set(seq, 'TOMBSTONE');
  }
  /** Marks a name taken and gone, as after a create whose response was lost and a later deletion. */
  tombstone(seq: number): void {
    this.names.set(seq, 'TOMBSTONE');
  }
  /** Every tombstone expired: those names can be created again. */
  forgetTombstones(): void {
    for (const [seq, s] of this.names) if (s === 'TOMBSTONE') this.names.delete(seq);
  }
  live(): number[] {
    return [...this.names].filter(([, s]) => s === 'LIVE').map(([seq]) => seq);
  }
}

export interface Order {
  /** Commit index, so that commits at the same instant keep their order. */
  readonly index: number;
  readonly at: number;
  readonly seq: number;
  readonly attention: boolean;
}

/** Worker commits: a lease or the outcome of a business attempt. Each is bounded by the attempt budget. */
const WORKER_PROGRESS = new Set(['S2', 'S3', 'S4', 'S5', 'S6', 'S7']);

export class World {
  readonly queue = new FakeQueue();
  readonly events: DomainEvent[] = [];
  readonly orders: Order[] = [];
  /** Commit indexes of worker progress (S2-S7). */
  readonly progress: number[] = [];
  private commits = 0;
  /** Set by tests that feed PERMANENT_ERROR outcomes. */
  allowPermanentError = false;
  /** Business-logic starts that happened before the model began. */
  private readonly priorStarts: number;

  constructor(
    public state: RequestState,
    public now = T0,
  ) {
    this.priorStarts = state.processing.attempts;
  }

  /** The API's S1 commit. Its createTask for seq 1 is up to the test (it may be lost or late). */
  static accepted(now = T0): World {
    const s1 = planAcceptance({ requestId: 'req', payloadFingerprint: 'fp', now }).write;
    const w = new World(apply(null, s1), now);
    w.events.push(...s1.events);
    return w;
  }

  advance(ms: number): this {
    this.now += ms;
    return this;
  }
  /** Moves the clock forward to `t`; time never goes back. */
  until(t: number | null): this {
    if (t !== null && t > this.now) this.now = t;
    return this;
  }

  commit(write: StateWrite | null): void {
    if (write === null) return;
    const before = this.state;
    const next = apply(before, write);
    this.state = next;
    this.events.push(...write.events);
    const index = this.commits++;
    if (write.transition === 'S9' || write.transition === 'S10') {
      this.orders.push({ index, at: this.now, seq: next.dispatch.seq, attention: write.transition === 'S10' });
    }
    if (WORKER_PROGRESS.has(write.transition)) this.progress.push(index);
    this.checkSafety(before, next);
  }

  /** Safety properties that must hold after every commit, under any scheduling. */
  private checkSafety(before: RequestState, next: RequestState): void {
    // I3: terminal states are absorbing.
    if (isTerminal(before)) expect(next.status).toBe(before.status);
    // No dispatch outcome is ever a business failure.
    expect(next.statusReason).not.toBe('DISPATCH_EXHAUSTED');
    if (next.status === 'FAILED' && before.status !== 'FAILED') {
      if (next.statusReason === 'ATTEMPTS_EXHAUSTED') {
        expect(next.processing.attempts).toBeGreaterThanOrEqual(next.processing.maxAttempts);
      } else {
        expect(next.statusReason === 'PERMANENT_ERROR' && this.allowPermanentError).toBe(true);
      }
    }
    // I5: business-logic starts are counted in Firestore and bounded.
    const starts = this.priorStarts + this.events.filter((e) => e.type === 'PROCESSING_STARTED').length;
    expect(starts).toBe(next.processing.attempts);
    expect(starts).toBeLessThanOrEqual(next.processing.maxAttempts);
    expect(this.events.filter((e) => e.type === 'COMPLETED').length).toBeLessThanOrEqual(1);
    // Every created name belongs to a committed order.
    expect(this.queue.created).toBeLessThanOrEqual(next.dispatch.seq);
  }

  /**
   * Rate bound: without worker progress in between, consecutive orders are at least 5 minutes apart, and
   * at least 30 minutes after an attention order. Worker progress is itself bounded by I5.
   */
  checkDispatchRate(): void {
    for (let i = 1; i < this.orders.length; i++) {
      const prev = this.orders[i - 1] as Order;
      const cur = this.orders[i] as Order;
      if (this.progress.some((p) => p > prev.index && p < cur.index)) continue;
      expect(cur.at - prev.at).toBeGreaterThanOrEqual(prev.attention ? ATTENTION_REDISPATCH_MS : RETRY_WATCHDOG_MS);
    }
  }
}

/** One reconciler instance, driven step by step through the adapter flow in `reconcile.ts`. */
export class Reconciler {
  stage: 'IDLE' | 'PROBED' | 'ORDERED' | 'CREATED' = 'IDLE';
  private probe: TaskProbe | null = null;
  order: EnqueueOrder | null = null;
  outcome: EnqueueOutcome | null = null;

  constructor(private readonly w: World) {}

  /** Step 1 and the getTask call of step 2 (plain read, no transaction). */
  plan(result?: ProbeResult): ReconcileDecision {
    const d = decideReconcile(this.w.state, null, this.w.now);
    if (d.kind === 'PROBE_TASK') {
      this.probe = { seq: d.seq, result: result ?? this.w.queue.get(d.seq) };
      this.stage = 'PROBED';
    } else {
      this.w.commit(d.write); // re-run in a transaction on the same serialised state
    }
    return d;
  }
  /** The transactional half of step 2, on whatever the state is by now. */
  decide(): ReconcileDecision {
    const d = decideReconcile(this.w.state, this.probe, this.w.now);
    this.w.commit(d.write);
    this.probe = null;
    this.stage = 'IDLE';
    if (d.kind === 'DISPATCH') {
      this.order = d.enqueue;
      this.stage = 'ORDERED';
    }
    return d;
  }
  /** Step 3: the unfenced side effect. It may run arbitrarily late. */
  create(): EnqueueOutcome {
    this.outcome = this.w.queue.create(this.requireOrder().seq);
    this.stage = 'CREATED';
    return this.outcome;
  }
  /** Step 3, second half. */
  record(outcome: EnqueueOutcome | null = this.outcome): EnqueueDecision {
    if (outcome === null) throw new Error('no outcome');
    const d = decideEnqueueResult(this.w.state, this.requireOrder(), outcome, this.w.now);
    this.w.commit(d.write);
    this.order = null;
    this.outcome = null;
    this.stage = 'IDLE';
    return d;
  }
  /** The process dies: whatever it had not done yet never happens. */
  crash(): void {
    this.probe = null;
    this.order = null;
    this.outcome = null;
    this.stage = 'IDLE';
  }
  /** Steps 1-2 without interruption. */
  pass(result?: ProbeResult): ReconcileDecision {
    const plan = this.plan(result);
    return plan.kind === 'PROBE_TASK' ? this.decide() : plan;
  }
  /** Steps 1-3 without interruption. */
  fullPass(result?: ProbeResult): ReconcileDecision {
    const d = this.pass(result);
    if (d.kind === 'DISPATCH') this.record(this.create());
    return d;
  }
  private requireOrder(): EnqueueOrder {
    if (this.order === null) throw new Error('no enqueue order');
    return this.order;
  }
}

/** One worker instance. Cloud Tasks acknowledges a task on 2xx and retries it on 409, 503 or no answer. */
export class Worker {
  lease: { readonly id: string; readonly seq: number } | null = null;
  private n = 0;

  constructor(
    private readonly w: World,
    private readonly name = 'W',
  ) {}

  deliver(seq: number): DeliveryDecision {
    const d = decideDelivery(this.w.state, { seq, leaseId: `${this.name}-${++this.n}` }, this.w.now);
    this.w.commit(d.write);
    if (d.kind === 'ACQUIRE_LEASE') this.lease = { id: d.lease.id, seq };
    else if (d.http === 200) this.w.queue.remove(seq);
    return d;
  }
  complete(outcome: ProcessingOutcome): CompletionDecision {
    if (this.lease === null) throw new Error('no lease');
    const d = decideCompletion(this.w.state, this.lease.id, outcome, this.w.now);
    this.w.commit(d.write);
    if (d.http === 200) this.w.queue.remove(this.lease.seq);
    this.lease = null;
    return d;
  }
  /** No HTTP answer: the task stays live and the queue retries it. */
  crash(): void {
    this.lease = null;
  }
}

/** Delivers task `seq` and runs it to completion. Returns the last decision kind. */
export function deliverAndComplete(w: World, seq: number, outcome: ProcessingOutcome = OK): string {
  const worker = new Worker(w, `once-${seq}`);
  const d = worker.deliver(seq);
  return d.kind === 'ACQUIRE_LEASE' ? worker.complete(outcome).kind : d.kind;
}

/**
 * Infrastructure restored and every remaining actor healthy: the queue delivers every live task, and one
 * reconciler runs whenever the request is due. Returns the time it took to reach a terminal status.
 */
export function drain(w: World, maxRounds = 50): number {
  w.queue.outage = false;
  w.queue.probeOverride = null;
  const start = w.now;
  const reconciler = new Reconciler(w);
  const worker = new Worker(w, 'drain');
  for (let round = 0; round < maxRounds && !isTerminal(w.state); round++) {
    for (const seq of w.queue.live()) {
      if (worker.deliver(seq).kind === 'ACQUIRE_LEASE') worker.complete(OK);
    }
    if (isTerminal(w.state)) break;
    w.until(w.state.watchdogAt);
    reconciler.fullPass();
  }
  expect(isTerminal(w.state)).toBe(true);
  return w.now - start;
}

/** Small deterministic PRNG (mulberry32) so every fuzz case is reproducible from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rnd: () => number, items: readonly T[]): T {
  return items[Math.floor(rnd() * items.length)] as T;
}
