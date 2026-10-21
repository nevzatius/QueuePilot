import { TaskPayloadSchema } from '@queuepilot/contracts';
import type { TaskPayload } from '@queuepilot/contracts';
import { taskName } from '@queuepilot/domain';
import type { Clock, TaskProbe } from '@queuepilot/domain';
import type { DispatchQueue } from '../queue.js';

export type LocalFaults = { create?: 'fail' | 'ambiguous'; probe?: TaskProbe['result']; permissionDenied?: boolean };
/**
 * Knobs of the `qstash` profile. `retries` follows Upstash-Retries (deliveries = retries + 1), `timeoutMs`
 * follows Upstash-Timeout. `dedupWindowMs` defaults to the 90 days Upstash documents for deduplication ids;
 * that figure is documented, not measured by us.
 */
export type LocalQStashOptions = { retries?: number; timeoutMs?: number; dedupWindowMs?: number };
export type LocalQueueOptions = {
  environment: 'development' | 'test' | 'production'; faults?: LocalFaults;
  /** `cloud-tasks` (default) models Cloud Tasks; `qstash` models the QStash semantics measured in ADR-019. */
  profile?: 'cloud-tasks' | 'qstash'; qstash?: LocalQStashOptions;
  maxAttempts?: number; maxRetryDurationMs?: number; minBackoffMs?: number; maxBackoffMs?: number;
  maxDoublings?: number; rate?: number; concurrency?: number; tombstoneMs?: number; deadlineMs?: number;
};
type Entry = { name: string; payload: TaskPayload; attempts: number; firstAt: number | null; due: number; running: boolean };
/** A bare status, or a status with the worker's Retry-After (honoured by the `qstash` profile only). */
export type LocalDeliveryResult = number | { status: number; retryAfterSeconds?: number };
export type LocalDelivery = (payload: TaskPayload, headers: Record<string, string>) => Promise<LocalDeliveryResult>;
export type LocalPublishOutcome = 'CREATED' | 'DEDUPLICATED';

/** QStash default retry delay as observed in ADR-019 (about 12 s, then about 154 s; n=1): e^(2.5 n) seconds, capped at one day. */
const qstashBackoffMs = (retryNumber: number) => Math.min(86_400, Math.exp(2.5 * retryNumber)) * 1000;

/** Explicit pump + injected Clock: no hidden timers, IO or wall time in the queue model. */
export class LocalDispatchQueue implements DispatchQueue {
  readonly faults: LocalFaults;
  private readonly tasks = new Map<string, Entry>();
  private readonly tombstones = new Map<string, number>();
  /** qstash profile: identity -> end of its deduplication window. */
  private readonly dedup = new Map<string, number>();
  private published = 0;
  private readonly deadlines = new Map<Entry, { at: number; expire: () => void; done: Promise<void> }>();
  private paused = false;
  private active = 0;
  private rateSecond = -1;
  private dispatched = 0;
  private readonly settings;
  readonly profile: 'cloud-tasks' | 'qstash';
  private readonly qstash: Required<LocalQStashOptions>;
  /** The wait after which a delivery counts as failed. The handler is not stopped. */
  get deadlineMs() { return this.settings.deadlineMs; }
  constructor(private readonly clock: Clock, options: LocalQueueOptions) {
    if (options.environment === 'production') throw new Error('Local dispatch is forbidden in production');
    this.faults = options.faults ?? {};
    this.profile = options.profile ?? 'cloud-tasks';
    this.qstash = { retries: 2, timeoutMs: 90_000, dedupWindowMs: 90 * 86_400_000, ...options.qstash };
    if (!Number.isInteger(this.qstash.retries) || this.qstash.retries < 0 || this.qstash.retries > 3
        || !(this.qstash.timeoutMs > 0) || !(this.qstash.dedupWindowMs > 0)) throw new Error('Invalid local queue limits');
    this.settings = { maxAttempts: 10, maxRetryDurationMs: 600_000, minBackoffMs: 2000,
      maxBackoffMs: 60_000, maxDoublings: 4, rate: 20, concurrency: 30, tombstoneMs: 3_600_000, deadlineMs: 30_000, ...options,
      ...(this.profile === 'qstash' && { deadlineMs: options.deadlineMs ?? this.qstash.timeoutMs }) };
    for (const key of ['maxAttempts', 'maxRetryDurationMs', 'minBackoffMs', 'maxBackoffMs', 'rate', 'concurrency', 'tombstoneMs', 'deadlineMs'] as const) {
      if (!Number.isInteger(this.settings[key]) || this.settings[key] <= 0) throw new Error('Invalid local queue limits');
    }
    if (!Number.isInteger(this.settings.maxDoublings) || this.settings.maxDoublings < 0) throw new Error('Invalid local queue backoff');
  }
  async enqueue(input: TaskPayload, signal: AbortSignal): Promise<void> {
    await this.publish(input, signal);
  }
  /**
   * `enqueue` plus the outcome. `qstash` profile: a repeated identity inside its window is `DEDUPLICATED`
   * (the real service answers 201 with `deduplicated:true`); past the window it is a new message, an extra
   * delivery that the worker absorbs (ADR-017). `cloud-tasks` profile: a duplicate name is a silent no-op.
   */
  async publish(input: TaskPayload, signal: AbortSignal): Promise<LocalPublishOutcome> {
    signal.throwIfAborted();
    const payload = TaskPayloadSchema.parse(input);
    if (this.faults.create === 'fail') throw new Error('LOCAL_CREATE_FAILED');
    const name = taskName(payload.requestId, payload.seq);
    const now = this.clock.now();
    let key = name;
    if (this.profile === 'qstash') {
      if ((this.dedup.get(name) ?? 0) > now) return 'DEDUPLICATED';
      this.dedup.set(name, now + this.qstash.dedupWindowMs);
      key = `${name}#${++this.published}`;
    } else {
      if (this.tasks.has(name) || (this.tombstones.get(name) ?? 0) > now) return 'DEDUPLICATED';
      this.tombstones.delete(name);
    }
    this.tasks.set(key, { name, payload, attempts: 0, firstAt: null, due: now, running: false });
    if (this.faults.create === 'ambiguous') throw new Error('LOCAL_CREATE_AMBIGUOUS');
    return 'CREATED';
  }
  async probe(requestId: string, seq: number): Promise<TaskProbe> {
    // The real adapter never calls QStash to probe (ADR-019), so the profile answers the same constant.
    if (this.profile === 'qstash') return { seq, result: 'UNKNOWN' };
    if (this.faults.permissionDenied) return { seq, result: 'UNKNOWN', errorCode: 'PERMISSION_DENIED' };
    return { seq, result: this.faults.probe ?? (this.tasks.has(taskName(requestId, seq)) ? 'EXISTS' : 'NOT_FOUND') };
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  purge() { for (const name of this.tasks.keys()) this.remove(name); }
  size() { return this.tasks.size; }
  private remove(name: string) {
    this.tasks.delete(name);
    if (this.profile === 'qstash') return; // deduplication ids, not name tombstones
    this.tombstones.set(name, this.clock.now() + this.settings.tombstoneMs);
  }
  async pump(deliver: LocalDelivery): Promise<number> {
    // Advancing a fake clock can expire a hung delivery without waiting for its handler.
    const expired = [...this.deadlines.values()].filter((run) => run.at <= this.clock.now());
    for (const run of expired) run.expire();
    await Promise.all(expired.map((run) => run.done));
    if (this.paused) return 0;
    const now = this.clock.now();
    const second = Math.floor(now / 1000);
    if (second !== this.rateSecond) { this.rateSecond = second; this.dispatched = 0; }
    const selected: Array<[string, Entry]> = [];
    for (const [name, entry] of this.tasks) {
      if (entry.running || entry.due > now) continue;
      if (this.profile === 'cloud-tasks' && entry.attempts >= this.settings.maxAttempts && entry.firstAt !== null && now - entry.firstAt >= this.settings.maxRetryDurationMs) {
        this.remove(name); continue;
      }
      if (this.active >= this.settings.concurrency || this.dispatched >= this.settings.rate) break;
      entry.running = true; entry.firstAt ??= now; this.active++; this.dispatched++;
      selected.push([name, entry]);
    }
    await Promise.all(selected.map(([name, entry]) => {
      let expire!: () => void;
      const timeout = new Promise<number>((resolve) => { expire = () => resolve(504); });
      const done = (async () => {
        const retry = entry.attempts++;
        let status = 503;
        let retryAfterSeconds: number | undefined;
        try {
          const headers = this.profile === 'qstash'
            ? { 'upstash-retried': String(retry), 'upstash-message-id': `msg_local_${entry.name}` }
            : { 'x-cloudtasks-taskretrycount': String(retry), 'x-cloudtasks-taskexecutioncount': String(entry.attempts),
              'x-cloudtasks-taskname': entry.name };
          const result = await Promise.race([Promise.resolve().then(() => deliver(entry.payload, headers)), timeout]);
          if (typeof result === 'number') status = result;
          else ({ status, retryAfterSeconds } = result);
          if (this.clock.now() - now >= this.settings.deadlineMs) { status = 504; retryAfterSeconds = undefined; }
        } catch { /* Pre-lease infrastructure failure: queue retry, no Firestore attempt. */ }
        finally { entry.running = false; this.active--; }
        if (this.tasks.get(name) !== entry) return; // purge while in flight
        if (status >= 200 && status < 300) this.remove(name);
        else if (this.profile === 'qstash') {
          // retries + 1 deliveries in all, then the message is dropped (QStash would dead-letter it).
          if (entry.attempts > this.qstash.retries) this.remove(name);
          else entry.due = this.clock.now() + (retryAfterSeconds !== undefined && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds, 86_400) * 1000 : qstashBackoffMs(entry.attempts));
        } else if (entry.attempts >= this.settings.maxAttempts && this.clock.now() - entry.firstAt! >= this.settings.maxRetryDurationMs) this.remove(name);
        else {
          const exponent = Math.min(retry, this.settings.maxDoublings);
          const linear = Math.max(1, retry - this.settings.maxDoublings + 1);
          entry.due = this.clock.now() + Math.min(this.settings.minBackoffMs * 2 ** exponent * linear, this.settings.maxBackoffMs);
        }
      })();
      this.deadlines.set(entry, { at: now + this.settings.deadlineMs, expire, done });
      return done.finally(() => { this.deadlines.delete(entry); });
    }));
    return selected.length;
  }
}
