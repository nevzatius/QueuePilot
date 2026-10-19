import type { Clock } from '@queuepilot/domain';
import type { Tenant } from './membership.js';
import { ApiError } from './errors.js';

export interface QuotaStore {
  consume(tenantId: string, uid: string, limits: Tenant['limits']): Promise<void>;
}
export interface RateLimiter {
  consume(key: string, limit: number): Promise<void>;
}

/** B5 replaces this seam with Redis. Public/enforced quotas always fail closed meanwhile. */
export const unavailableQuota: QuotaStore = { consume: async () => { throw new ApiError('QUOTA_UNAVAILABLE', 30); } };

export class MemoryRateLimiter implements RateLimiter {
  private readonly entries = new Map<string, { count: number; until: number }>();
  constructor(private readonly clock: Clock, private readonly maxInstances = 5) {}
  async consume(key: string, limit: number) {
    const now = this.clock.now();
    let value = this.entries.get(key);
    if (!value || now >= value.until) {
      if (this.entries.size >= 10_000) {
        for (const [id, entry] of this.entries) if (now >= entry.until) this.entries.delete(id);
        if (this.entries.size >= 10_000) throw new ApiError('OVERLOADED', 1);
      }
      value = { count: 0, until: now + 60_000 };
      this.entries.set(key, value);
    }
    if (value.count >= Math.max(1, Math.floor(limit / this.maxInstances))) throw new ApiError('RATE_LIMITED', Math.max(1, Math.ceil((value.until - now) / 1000)));
    value.count++;
  }
}

export class AdmissionControl {
  private tokens: number;
  private lastRefill: number;
  private inflight = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly clock: Clock, private readonly rps = 40, private readonly maxInflight = 32, private readonly maxBacklog = 20_000) {
    this.tokens = rps;
    this.lastRefill = clock.now();
  }
  async acquire(backlog?: () => Promise<number>): Promise<() => void> {
    const now = this.clock.now();
    this.tokens = Math.min(this.rps, this.tokens + Math.max(0, now - this.lastRefill) * this.rps / 1000);
    this.lastRefill = now;
    if (this.tokens < 1) throw new ApiError('OVERLOADED', 1);
    this.tokens--;
    if (this.inflight >= this.maxInflight) {
      if (this.waiters.length >= this.maxInflight) throw new ApiError('OVERLOADED', 1);
      await new Promise<void>((resolve, reject) => {
        const wake = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new ApiError('OVERLOADED', 1));
        }, 100);
        this.waiters.push(wake);
      });
    } else this.inflight++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next(); // transfer the slot without opening a race for a new caller
      else this.inflight--;
    };
    try {
      let count: number | undefined;
      try { count = await backlog?.(); } catch { /* ADR-012 permits skipping an unavailable backlog metric. */ }
      if (count !== undefined && count > this.maxBacklog) throw new ApiError('BACKLOG_FULL', 5);
      return release;
    } catch (error) { release(); throw error; }
  }
}
