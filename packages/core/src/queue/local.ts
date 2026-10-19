import { TaskPayloadSchema } from '@queuepilot/contracts';
import type { TaskPayload } from '@queuepilot/contracts';
import { taskName } from '@queuepilot/domain';
import type { Clock, TaskProbe } from '@queuepilot/domain';
import type { DispatchQueue } from '../queue.js';

export type LocalFaults = { create?: 'fail' | 'ambiguous'; probe?: TaskProbe['result']; permissionDenied?: boolean };
export type LocalQueueOptions = {
  environment: 'development' | 'test' | 'production'; faults?: LocalFaults;
  maxAttempts?: number; maxRetryDurationMs?: number; minBackoffMs?: number; maxBackoffMs?: number;
  maxDoublings?: number; rate?: number; concurrency?: number; tombstoneMs?: number; deadlineMs?: number;
};
type Entry = { payload: TaskPayload; attempts: number; firstAt: number | null; due: number; running: boolean };
export type LocalDelivery = (payload: TaskPayload, headers: Record<string, string>) => Promise<number>;

/** Explicit pump + injected Clock: no hidden timers, IO or wall time in the queue model. */
export class LocalDispatchQueue implements DispatchQueue {
  readonly faults: LocalFaults;
  private readonly tasks = new Map<string, Entry>();
  private readonly tombstones = new Map<string, number>();
  private readonly deadlines = new Map<Entry, { at: number; expire: () => void; done: Promise<void> }>();
  private paused = false;
  private active = 0;
  private rateSecond = -1;
  private dispatched = 0;
  private readonly settings;
  constructor(private readonly clock: Clock, options: LocalQueueOptions) {
    if (options.environment === 'production') throw new Error('Local dispatch is forbidden in production');
    this.faults = options.faults ?? {};
    this.settings = { maxAttempts: 10, maxRetryDurationMs: 600_000, minBackoffMs: 2000,
      maxBackoffMs: 60_000, maxDoublings: 4, rate: 20, concurrency: 30, tombstoneMs: 3_600_000, deadlineMs: 30_000, ...options };
    for (const key of ['maxAttempts', 'maxRetryDurationMs', 'minBackoffMs', 'maxBackoffMs', 'rate', 'concurrency', 'tombstoneMs', 'deadlineMs'] as const) {
      if (!Number.isInteger(this.settings[key]) || this.settings[key] <= 0) throw new Error('Invalid local queue limits');
    }
    if (!Number.isInteger(this.settings.maxDoublings) || this.settings.maxDoublings < 0) throw new Error('Invalid local queue backoff');
  }
  async enqueue(input: TaskPayload, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const payload = TaskPayloadSchema.parse(input);
    if (this.faults.create === 'fail') throw new Error('LOCAL_CREATE_FAILED');
    const name = taskName(payload.requestId, payload.seq);
    if (this.tasks.has(name) || (this.tombstones.get(name) ?? 0) > this.clock.now()) return;
    this.tombstones.delete(name);
    this.tasks.set(name, { payload, attempts: 0, firstAt: null, due: this.clock.now(), running: false });
    if (this.faults.create === 'ambiguous') throw new Error('LOCAL_CREATE_AMBIGUOUS');
  }
  async probe(requestId: string, seq: number): Promise<TaskProbe> {
    if (this.faults.permissionDenied) return { seq, result: 'UNKNOWN', errorCode: 'PERMISSION_DENIED' };
    return { seq, result: this.faults.probe ?? (this.tasks.has(taskName(requestId, seq)) ? 'EXISTS' : 'NOT_FOUND') };
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  purge() { for (const name of this.tasks.keys()) this.remove(name); }
  size() { return this.tasks.size; }
  private remove(name: string) {
    this.tasks.delete(name);
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
      if (entry.attempts >= this.settings.maxAttempts && entry.firstAt !== null && now - entry.firstAt >= this.settings.maxRetryDurationMs) {
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
        try {
          status = await Promise.race([Promise.resolve().then(() => deliver(entry.payload, {
            'x-cloudtasks-taskretrycount': String(retry), 'x-cloudtasks-taskexecutioncount': String(entry.attempts),
            'x-cloudtasks-taskname': name })), timeout]);
          if (this.clock.now() - now >= this.settings.deadlineMs) status = 504;
        } catch { /* Pre-lease infrastructure failure: queue retry, no Firestore attempt. */ }
        finally { entry.running = false; this.active--; }
        if (this.tasks.get(name) !== entry) return; // purge while in flight
        if (status >= 200 && status < 300) this.remove(name);
        else if (entry.attempts >= this.settings.maxAttempts && this.clock.now() - entry.firstAt! >= this.settings.maxRetryDurationMs) this.remove(name);
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
