import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BURST_SCRIPT, QUOTA_SCRIPT, QUOTA_RELEASE_SCRIPT, createRedisConnection, quotaKeys, burstKey } from '@queuepilot/core';

const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const parsed = new URL(url);
if (parsed.protocol !== 'redis:' || !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
  throw new Error('REDIS_URL must identify local Redis');
}
const client = createRedisConnection(url);
const touched = new Set<string>();
const tenant = `b5-${randomUUID()}`;
const now = Date.UTC(2026, 9, 20, 23, 59, 30);
const ttl = 90_000; // 30s to UTC midnight + the 60s cleanup margin.
async function consume(tenantId: string, uid: string, userLimit: number, tenantLimit: number) {
  const keys = quotaKeys(tenantId, uid, now, randomUUID());
  for (const key of keys) touched.add(key);
  const result = await client.eval(QUOTA_SCRIPT, 3, ...keys, String(userLimit), String(tenantLimit), String(ttl));
  return { result, keys };
}

describe('B5 real Redis Lua scripts (Redis is required)', () => {
  // No skip or fallback: ECONNREFUSED rejects this hook when Redis is missing.
  beforeAll(async () => { await client.connect(); });
  afterAll(async () => {
    try {
      if (client.status === 'ready') {
        if (touched.size) await client.eval("return redis.call('DEL', unpack(KEYS))", touched.size, ...touched);
        await client.quit();
      }
    } finally { client.disconnect(); }
  });

  it('admits N, rejects N+1 atomically, and retains bounded UTC day TTLs', async () => {
    const id = `${tenant}-boundary`;
    expect((await consume(id, 'alice', 2, 10)).result).toBe(1);
    const accepted = await consume(id, 'alice', 2, 10);
    expect(accepted.result).toBe(1);
    expect((await consume(id, 'alice', 2, 10)).result).toBe(0);
    expect(await client.get(accepted.keys[0]!)).toBe('2');
    expect(await client.get(accepted.keys[1]!)).toBe('2');
    for (const key of accepted.keys) {
      const remaining = await client.eval("return redis.call('PTTL', KEYS[1])", 1, key) as number;
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(ttl);
    }
  });
  it('allows exactly N of N+k concurrent user and tenant quota calls', async () => {
    const user = await Promise.all(Array.from({ length: 15 }, () => consume(`${tenant}-user`, 'alice', 7, 30)));
    expect(user.filter(({ result }) => result === 1)).toHaveLength(7);
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => consume(`${tenant}-concurrent`, `user-${i}`, 30, 7)));
    expect(results.filter(({ result }) => result === 1)).toHaveLength(7);
  });
  it('isolates tenants and users and makes reservation release idempotent', async () => {
    const first = await consume(`${tenant}-a`, 'alice', 1, 10);
    expect((await consume(`${tenant}-a`, 'alice', 1, 10)).result).toBe(0);
    expect((await consume(`${tenant}-a`, 'bob', 1, 10)).result).toBe(1);
    expect((await consume(`${tenant}-b`, 'alice', 1, 10)).result).toBe(1);
    expect(await client.eval(QUOTA_SCRIPT, 3, ...first.keys, '1', '10', String(ttl))).toBe(1);
    expect(await client.get(first.keys[0]!)).toBe('1');
    expect(await client.eval(QUOTA_RELEASE_SCRIPT, 3, ...first.keys)).toBe(1);
    expect(await client.eval(QUOTA_RELEASE_SCRIPT, 3, ...first.keys)).toBe(0);
    expect((await consume(`${tenant}-a`, 'alice', 1, 10)).result).toBe(1);
  });
  it('atomically counts bursts with a bounded TTL and separate tenant/minute keys', async () => {
    const key = burstKey(JSON.stringify([tenant, 'alice']), now);
    touched.add(key);
    const counts = await Promise.all(Array.from({ length: 12 }, () => client.eval(BURST_SCRIPT, 1, key, '30000')));
    expect(counts.map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    const remaining = await client.eval("return redis.call('PTTL', KEYS[1])", 1, key) as number;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(30_000);
    for (const scope of [JSON.stringify([`${tenant}-other`, 'alice']), JSON.stringify([tenant, 'bob'])]) {
      const separate = burstKey(scope, now);
      touched.add(separate);
      expect(await client.eval(BURST_SCRIPT, 1, separate, '30000')).toBe(1);
    }
    const next = burstKey(JSON.stringify([tenant, 'alice']), now + 60_000);
    touched.add(next);
    expect(await client.eval(BURST_SCRIPT, 1, next, '60000')).toBe(1);
  });
});
