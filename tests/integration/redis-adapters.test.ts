import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiError, ManagedRedis, QUOTA_SCRIPT, RedisQuotaStore, RedisRateLimiter, createRedisConnection, quotaKeys,
} from '@queuepilot/core';
import type { RedisConnection } from '@queuepilot/core';

// Real Redis (no test doubles): the adapter classes the API runs with, against the CI/local Redis service.
const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const parsed = new URL(url);
if (parsed.protocol !== 'redis:' || !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
  throw new Error('REDIS_URL must identify local Redis');
}
const DEAD_URL = 'redis://127.0.0.1:1'; // Nothing listens on port 1: connection refused.
const now = Date.UTC(2026, 9, 20, 23, 59, 30); // 30 s before UTC midnight.
const clock = { now: () => now };
const limits = (user: number, tenant: number) => ({ submitPerMin: 1000, submitPerDayUser: user, submitPerDayTenant: tenant });
const log = { warn: () => {} };
const prefix = `ra-${randomUUID().slice(0, 8)}`;

const admin = createRedisConnection(url);
const managed: ManagedRedis[] = [];
function live(): ManagedRedis {
  const redis = new ManagedRedis(createRedisConnection(url), clock);
  managed.push(redis);
  return redis;
}
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(ApiError); return error as ApiError; }
  throw new Error('Expected the call to be rejected');
}

beforeAll(async () => { await admin.connect(); });
afterAll(async () => {
  await Promise.all(managed.map((redis) => redis.close()));
  try {
    if (admin.status === 'ready') {
      const keys = await (admin as unknown as { keys(pattern: string): Promise<string[]> }).keys(`qp:*${prefix}*`);
      if (keys.length) await admin.eval("return redis.call('DEL', unpack(KEYS))", keys.length, ...keys);
      await admin.quit();
    }
  } finally { admin.disconnect(); }
});

describe('RedisQuotaStore on real Redis', () => {
  it('admits exactly N, then rejects with QUOTA_EXCEEDED and a Retry-After equal to the seconds left in the UTC day', async () => {
    const store = new RedisQuotaStore(live(), clock);
    const tenant = `${prefix}-boundary`;
    await store.consume(tenant, 'alice', limits(2, 10));
    await store.consume(tenant, 'alice', limits(2, 10));
    const error = await rejection(store.consume(tenant, 'alice', limits(2, 10)));
    expect(error.code).toBe('QUOTA_EXCEEDED');
    expect(error.retryAfter).toBe(30);
  });

  it('enforces the tenant budget across users and keeps tenants and users separate', async () => {
    const store = new RedisQuotaStore(live(), clock);
    const tenant = `${prefix}-tenant`;
    await store.consume(tenant, 'alice', limits(5, 2));
    await store.consume(tenant, 'bob', limits(5, 2));
    expect((await rejection(store.consume(tenant, 'carol', limits(5, 2)))).code).toBe('QUOTA_EXCEEDED');
    await store.consume(`${tenant}-other`, 'carol', limits(5, 2)); // A different tenant has its own budget.
    const solo = `${prefix}-solo`;
    await store.consume(solo, 'alice', limits(1, 10));
    expect((await rejection(store.consume(solo, 'alice', limits(1, 10)))).code).toBe('QUOTA_EXCEEDED');
    await store.consume(solo, 'bob', limits(1, 10)); // Alice exhausting her own budget does not block Bob.
  });

  it('admits exactly N of N+k concurrent callers from independent connections', async () => {
    const tenant = `${prefix}-race`;
    const stores = Array.from({ length: 3 }, () => new RedisQuotaStore(live(), clock));
    const outcomes = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => stores[i % 3]!.consume(tenant, `user-${i}`, limits(50, 6))));
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(6);
    expect(rejected).toHaveLength(10);
    expect(rejected.every((o) => o.reason instanceof ApiError && o.reason.code === 'QUOTA_EXCEEDED')).toBe(true);
  });

  it('releases a reservation once; a second cancel never refunds more than was charged', async () => {
    const store = new RedisQuotaStore(live(), clock);
    const tenant = `${prefix}-release`;
    const first = await store.reserve(tenant, 'alice', limits(1, 5));
    expect((await rejection(store.reserve(tenant, 'alice', limits(1, 5)))).code).toBe('QUOTA_EXCEEDED');
    await first.cancel();
    await first.cancel();
    const second = await store.reserve(tenant, 'alice', limits(1, 5)); // Budget restored exactly once.
    expect((await rejection(store.reserve(tenant, 'alice', limits(1, 5)))).code).toBe('QUOTA_EXCEEDED');
    await second.cancel();
  });

  it('expires the counters at their TTL so the budget reopens', async () => {
    const tenant = `${prefix}-ttl`;
    const keys = quotaKeys(tenant, 'alice', now, randomUUID());
    const call = () => admin.eval(QUOTA_SCRIPT, 3, ...keys, '1', '1', '200');
    expect(await call()).toBe(1);
    const second = quotaKeys(tenant, 'alice', now, randomUUID());
    expect(await admin.eval(QUOTA_SCRIPT, 3, ...second, '1', '1', '200')).toBe(0);
    await delay(400);
    expect(await admin.get(keys[0]!)).toBeNull();
    expect(await admin.eval(QUOTA_SCRIPT, 3, ...second, '1', '1', '200')).toBe(1);
  });

  it('fails closed with QUOTA_UNAVAILABLE (Retry-After 30) when Redis is unreachable, and open only when configured', async () => {
    const dead = new ManagedRedis(createRedisConnection(DEAD_URL), clock);
    managed.push(dead);
    const closed = await rejection(new RedisQuotaStore(dead, clock).consume(`${prefix}-dead`, 'alice', limits(5, 5)));
    expect(closed.code).toBe('QUOTA_UNAVAILABLE');
    expect(closed.retryAfter).toBe(30);
    await expect(new RedisQuotaStore(dead, clock, 'open').consume(`${prefix}-dead`, 'alice', limits(5, 5))).resolves.toBeUndefined();
  });

  it('recovers after its connection is killed: only fail-closed errors in between, then normal admission', async () => {
    const connection = createRedisConnection(url);
    const redis = new ManagedRedis(connection, clock);
    managed.push(redis);
    const store = new RedisQuotaStore(redis, clock);
    const tenant = `${prefix}-reconnect`;
    await store.consume(tenant, 'alice', limits(50, 50));
    const call = (c: RedisConnection, ...args: string[]) =>
      (c as unknown as { call(...parts: string[]): Promise<unknown> }).call(...args);
    const id = await call(connection, 'CLIENT', 'ID');
    expect(await call(admin, 'CLIENT', 'KILL', 'ID', String(id))).toBe(1);
    const errors: string[] = [];
    let recovered = false;
    for (let attempt = 0; attempt < 4 && !recovered; attempt++) {
      try { await store.consume(tenant, 'alice', limits(50, 50)); recovered = true; }
      catch (error) { errors.push((error as ApiError).code); await delay(50); }
    }
    expect(recovered).toBe(true);
    expect(errors.every((code) => code === 'QUOTA_UNAVAILABLE')).toBe(true);
    expect(errors.length).toBeLessThanOrEqual(2);
  });
});

describe('RedisRateLimiter on real Redis', () => {
  it('counts one shared window across instances and reports Retry-After for the rest of the minute', async () => {
    const a = new RedisRateLimiter(live(), clock, 5, log);
    const b = new RedisRateLimiter(live(), clock, 5, log);
    const key = `${prefix}-burst`;
    await a.consume(key, 3);
    await b.consume(key, 3);
    await a.consume(key, 3);
    // The 4th call is over the limit on either instance: the window is global, not per instance.
    const error = await rejection(b.consume(key, 3));
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfter).toBe(30);
    expect((await rejection(a.consume(key, 3))).code).toBe('RATE_LIMITED');
    await a.consume(`${key}-other`, 3); // Separate key, separate window.
  });

  it('degrades to the per-instance limit (not an outage) when Redis is unreachable', async () => {
    const dead = new ManagedRedis(createRedisConnection(DEAD_URL), clock);
    managed.push(dead);
    const limiter = new RedisRateLimiter(dead, clock, 5, log);
    const key = `${prefix}-degraded`;
    await limiter.consume(key, 10); // floor(10 / 5 instances) = 2 per instance.
    await limiter.consume(key, 10);
    expect((await rejection(limiter.consume(key, 10))).code).toBe('RATE_LIMITED');
  });
});
