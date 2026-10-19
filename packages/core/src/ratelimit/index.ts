import type { Clock } from '@queuepilot/domain';
import type { RateLimiter } from '../admission.js';
import { ApiError } from '../errors.js';
import type { RedisAccess, RedisLog } from '../cache/redis.js';

export const BURST_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export function burstKey(key: string, now: number): string {
  return `qp:burst:${encodeURIComponent(key)}:${Math.floor(now / 60_000)}`;
}

export class RedisRateLimiter implements RateLimiter {
  private readonly fallback: FixedWindowMemoryLimiter;
  constructor(private readonly redis: RedisAccess, private readonly clock: Clock,
    maxInstances: number, private readonly log: RedisLog) {
    this.fallback = new FixedWindowMemoryLimiter(clock, maxInstances);
  }
  async consume(key: string, limit: number): Promise<void> {
    const now = this.clock.now();
    const remaining = 60_000 - now % 60_000;
    let count: unknown;
    try {
      count = await this.redis.eval(BURST_SCRIPT, [burstKey(key, now)], [String(remaining)]);
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) throw new Error('Invalid counter');
    } catch {
      this.log.warn({ code: 'ratelimit.degraded' }, 'Using per-instance burst limits');
      return this.fallback.consume(key, limit);
    }
    if (count > limit) throw new ApiError('RATE_LIMITED', Math.max(1, Math.ceil(remaining / 1000)));
  }
}

export class FixedWindowMemoryLimiter implements RateLimiter {
  private readonly entries = new Map<string, { count: number; until: number }>();
  constructor(private readonly clock: Clock, private readonly maxInstances = 5) {}
  async consume(key: string, limit: number): Promise<void> {
    const now = this.clock.now();
    let entry = this.entries.get(key);
    if (!entry || now >= entry.until) {
      if (this.entries.size >= 10_000) {
        for (const [id, value] of this.entries) if (now >= value.until) this.entries.delete(id);
        if (this.entries.size >= 10_000) throw new ApiError('OVERLOADED', 1);
      }
      entry = { count: 0, until: now - now % 60_000 + 60_000 };
      this.entries.set(key, entry);
    }
    if (entry.count >= Math.floor(limit / this.maxInstances)) {
      throw new ApiError('RATE_LIMITED', Math.max(1, Math.ceil((entry.until - now) / 1000)));
    }
    entry.count++;
  }
}
