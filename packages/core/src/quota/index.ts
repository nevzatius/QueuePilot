import { randomUUID } from 'node:crypto';
import type { Clock } from '@queuepilot/domain';
import type { QuotaStore } from '../admission.js';
import type { Tenant } from '../membership.js';
import type { RedisAccess } from '../cache/redis.js';
import { ApiError } from '../errors.js';

/** Both budgets and the operation receipt change together, including at the exact boundary. */
export const QUOTA_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 1 end
local user = tonumber(redis.call('GET', KEYS[1]) or '0')
local tenant = tonumber(redis.call('GET', KEYS[2]) or '0')
if user >= tonumber(ARGV[1]) or tenant >= tonumber(ARGV[2]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], '1', 'PX', ARGV[3])
return 1
`;
export const QUOTA_RELEASE_SCRIPT = `
if redis.call('DEL', KEYS[3]) == 0 then return 0 end
for i = 1, 2 do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count > 0 then redis.call('DECR', KEYS[i]) end
end
return 1
`;

export function quotaKeys(tenantId: string, uid: string, now: number, operationId: string): string[] {
  const prefix = `qp:quota:{${encodeURIComponent(tenantId)}}:${new Date(now).toISOString().slice(0, 10)}`;
  return [`${prefix}:user:${encodeURIComponent(uid)}`, `${prefix}:tenant`, `${prefix}:reservation:${operationId}`];
}

export interface QuotaReservation { cancel(): Promise<void> }
export class RedisQuotaStore implements QuotaStore {
  constructor(private readonly redis: RedisAccess, private readonly clock: Clock,
    private readonly failureMode: 'closed' | 'open' = 'closed') {}
  async consume(tenantId: string, uid: string, limits: Tenant['limits']): Promise<void> {
    await this.reserve(tenantId, uid, limits);
  }
  async reserve(tenantId: string, uid: string, limits: Tenant['limits']): Promise<QuotaReservation> {
    const now = this.clock.now();
    const remaining = 86_400_000 - now % 86_400_000;
    const keys = quotaKeys(tenantId, uid, now, randomUUID());
    let allowed: unknown;
    try {
      allowed = await this.redis.eval(QUOTA_SCRIPT, keys,
        [String(limits.submitPerDayUser), String(limits.submitPerDayTenant), String(remaining + 60_000)]);
      if (allowed !== 0 && allowed !== 1) throw new Error('Invalid quota result');
    } catch {
      if (this.failureMode === 'open') return { cancel: async () => {} };
      throw new ApiError('QUOTA_UNAVAILABLE', 30);
    }
    if (allowed === 0) throw new ApiError('QUOTA_EXCEEDED', Math.max(1, Math.ceil(remaining / 1000)));
    return { cancel: async () => {
      try { await this.redis.eval(QUOTA_RELEASE_SCRIPT, keys, []); }
      catch { /* An unconfirmed release conservatively retains the reservation until UTC rollover. */ }
    } };
  }
}
