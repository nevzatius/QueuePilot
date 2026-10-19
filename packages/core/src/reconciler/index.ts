import { decideEnqueueResult, decideReconcile } from '@queuepilot/domain';
import type { Clock, EnqueueOutcome, TaskProbe } from '@queuepilot/domain';
import type { Logger } from 'pino';
import { enqueueAccepted } from '../queue.js';
import type { DispatchQueue } from '../queue.js';
import type { ProcessingStore, RequestIdentity } from '../processing/store.js';
import { requestState } from '../processing/store.js';

export class Reconciler {
  constructor(private readonly store: ProcessingStore, private readonly queue: DispatchQueue,
    private readonly clock: Clock, private readonly log: Logger, private readonly shards = 4, private readonly limit = 25) {
    if (!Number.isInteger(shards) || shards < 1 || shards > 4 || !Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new Error('Invalid reconciler bounds');
    }
  }
  private running: Promise<{ scanned: number }> | undefined;
  /** At most one bounded scan per instance at a time; watchdogs enforce the per-request cadence. */
  run(): Promise<{ scanned: number }> {
    return this.running ??= this.scan().finally(() => { this.running = undefined; });
  }
  private async scan() {
    let scanned = 0;
    for (let shard = 0; shard < this.shards; shard++) {
      const requests = await this.store.due(shard, this.limit, this.clock.now());
      scanned += requests.length;
      // Sequential IO caps probe/create pressure at 100 requests per Scheduler invocation.
      for (const identity of requests) await this.reconcile(identity);
    }
    return { scanned };
  }
  async reconcile(identity: RequestIdentity) {
    const initial = await this.store.read(identity);
    const first = decideReconcile(requestState(initial), null, this.clock.now());
    let probe: TaskProbe | null = null;
    if (first.kind === 'PROBE_TASK') {
      try { probe = await this.queue.probe(identity.requestId, first.seq); }
      catch { probe = { seq: first.seq, result: 'UNKNOWN', errorCode: 'UNKNOWN' }; }
      if (probe.result === 'UNKNOWN') this.log.error({ ...identity, correlationId: initial?.correlationId ?? identity.requestId,
        seq: first.seq, code: 'PROBE_UNKNOWN',
        errorCode: probe.errorCode }, 'Task probe unknown');
    }
    const committed = await this.store.transact(identity, (fresh, now) => decideReconcile(requestState(fresh), probe, now));
    const decision = committed.decision;
    const request = committed.request;
    if (decision.kind !== 'DISPATCH' || request === null) return decision;
    const payload = { ...identity, seq: decision.enqueue.seq, correlationId: request.correlationId };
    this.log[decision.attention ? 'warn' : 'info']({ ...payload, code: decision.attention ? 'DISPATCH_ATTENTION' : 'DISPATCH_ORDERED' }, 'Dispatch order committed');
    let outcome: EnqueueOutcome;
    try { await enqueueAccepted(this.queue, payload); outcome = { result: 'CREATED' }; }
    catch {
      outcome = { result: 'FAILED', error: { code: 'ENQUEUE_FAILED', message: 'Task creation failed or timed out' } };
      this.log.error({ ...payload, code: 'ENQUEUE_FAILED' }, 'Dispatch awaits watchdog');
    }
    await this.store.transact(identity, (fresh, now) => decideEnqueueResult(requestState(fresh), decision.enqueue, outcome, now));
    return decision;
  }
}
