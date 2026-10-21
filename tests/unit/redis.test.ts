import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CachedMetricsService, createLogger, loadConfig, ManagedRedis, RedisMetricsCache,
  RedisQuotaStore, RedisRateLimiter, RedisUnavailable, metricsKey, quotaKeys,
} from '@queuepilot/core';
import type { MetricsResponse } from '@queuepilot/contracts';
import type { RequestRepository } from '@queuepilot/core';
import { FakeClock, RedisDouble } from './redis-double.js';

const limits = { submitPerMin: 10, submitPerDayUser: 3, submitPerDayTenant: 5 };
function fixture() {
  const clock = new FakeClock();
  const connection = new RedisDouble(clock);
  const redis = new ManagedRedis(connection, clock);
  return { clock, connection, redis, quota: new RedisQuotaStore(redis, clock) };
}
afterEach(() => vi.useRealTimers());

describe('bounded Redis lifecycle', () => {
  it('connects lazily and closes with quit and disconnect', async () => {
    const { redis, connection } = fixture();
    expect(connection.connects).toBe(0);
    await redis.get('key');
    await redis.close();
    expect(connection.connects).toBe(1);
    expect(connection.quits).toBe(1);
    expect(connection.disconnects).toBe(1);
    await expect(redis.get('key')).rejects.toBeInstanceOf(RedisUnavailable);
  });
  it('opens after five failures, allows one half-open probe, reconnects and resets', async () => {
    const { redis, connection, clock } = fixture();
    connection.mode = 'fail';
    for (let i = 0; i < 5; i++) await expect(redis.get('key')).rejects.toThrow('Redis unavailable');
    expect(connection.commands).toBe(5);
    await expect(redis.get('key')).rejects.toThrow('Redis unavailable');
    clock.advance(29_999);
    await expect(redis.get('key')).rejects.toThrow();
    expect(connection.commands).toBe(5);
    clock.advance(1);
    connection.mode = 'healthy';
    const probe = redis.get('key');
    await expect(redis.get('key')).rejects.toThrow();
    expect(await probe).toBeNull();
    expect(connection.connects).toBe(6);
    connection.disconnect();
    expect(await redis.get('key')).toBeNull();
    expect(connection.connects).toBe(7);
  });
  it('reopens for 30s when the half-open probe fails', async () => {
    const { redis, connection, clock } = fixture();
    connection.mode = 'fail';
    for (let i = 0; i < 5; i++) await redis.get('key').catch(() => {});
    clock.advance(30_000);
    await expect(redis.get('key')).rejects.toThrow();
    connection.mode = 'healthy';
    clock.advance(29_999);
    await expect(redis.get('key')).rejects.toThrow();
    clock.advance(1);
    expect(await redis.get('key')).toBeNull();
  });
  it('bounds commands to 100ms, disconnects and masks errors containing secrets', async () => {
    vi.useFakeTimers();
    const { redis, connection } = fixture();
    connection.mode = 'timeout';
    const assertion = expect(redis.get('key')).rejects.toThrow('Redis unavailable');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(connection.disconnects).toBe(1);
    connection.mode = 'fail';
    await expect(redis.get('key')).rejects.not.toThrow(/secret-password|private-host/);
  });
  it('never sends a command after a connect timeout or shutdown', async () => {
    vi.useFakeTimers();
    const { redis, connection } = fixture();
    let finish!: () => void;
    vi.spyOn(connection, 'connect').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const assertion = expect(redis.get('key')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    finish();
    await Promise.resolve();
    expect(connection.commands).toBe(0);
    await redis.close();
  });
  it('bounds shutdown when quit stalls', async () => {
    vi.useFakeTimers();
    const { redis, connection } = fixture();
    await redis.get('key');
    vi.spyOn(connection, 'quit').mockImplementation(() => new Promise(() => {}));
    const closing = redis.close();
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    expect(connection.disconnects).toBe(1);
  });
});

describe('atomic submission quotas', () => {
  it('allows N and rejects N+1 without incrementing either budget on denial', async () => {
    const { quota, connection, clock } = fixture();
    for (let i = 0; i < 3; i++) await quota.consume('alpha', 'alice', limits);
    await expect(quota.consume('alpha', 'alice', limits)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', retryAfter: 43_190 });
    const keys = quotaKeys('alpha', 'alice', clock.now(), 'unused');
    expect(connection.entries.get(keys[0]!)?.value).toBe('3');
    expect(connection.entries.get(keys[1]!)?.value).toBe('3');
  });
  it('admits exactly N of N+k concurrent calls across instances', async () => {
    const { quota, redis, clock } = fixture();
    const second = new RedisQuotaStore(redis, clock);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? quota : second).consume('alpha', `user-${i}`, limits)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
  });
  it('isolates tenants and users, resets at UTC midnight and sets TTL to day end plus margin', async () => {
    const { quota, clock, connection } = fixture();
    for (let i = 0; i < 3; i++) await quota.consume('alpha', 'alice', limits);
    await quota.consume('alpha', 'bob', limits);
    await quota.consume('beta', 'alice', limits);
    const key = quotaKeys('alpha', 'alice', clock.now(), 'unused')[0]!;
    expect(connection.entries.get(key)?.until).toBe(Date.UTC(2026, 9, 21) + 60_000);
    clock.value = Date.UTC(2026, 9, 21);
    await quota.consume('alpha', 'alice', limits);
    expect(quotaKeys('a:b', 'c', clock.now(), 'x')).not.toEqual(quotaKeys('a', 'b:c', clock.now(), 'x'));
  });
  it('releases reservations exactly once for submissions that did not commit', async () => {
    const { quota } = fixture();
    const reservation = await quota.reserve('alpha', 'alice', { ...limits, submitPerDayUser: 1 });
    await reservation.cancel();
    await reservation.cancel();
    await quota.consume('alpha', 'alice', { ...limits, submitPerDayUser: 1 });
    await expect(quota.consume('alpha', 'alice', { ...limits, submitPerDayUser: 1 })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
  it('fails closed on disconnect, timeout and disabled Redis', async () => {
    const { quota, connection, clock } = fixture();
    connection.mode = 'fail';
    await expect(quota.consume('alpha', 'alice', limits)).rejects.toMatchObject({ code: 'QUOTA_UNAVAILABLE', retryAfter: 30 });
    const disabled = new RedisQuotaStore(new ManagedRedis(undefined, clock), clock);
    await expect(disabled.consume('alpha', 'alice', limits)).rejects.toMatchObject({ code: 'QUOTA_UNAVAILABLE' });
    vi.useFakeTimers();
    connection.mode = 'timeout';
    const assertion = expect(quota.consume('alpha', 'alice', limits)).rejects.toMatchObject({ code: 'QUOTA_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });
  it('permits explicit non-production fail-open and rejects it in production at startup', async () => {
    const { clock } = fixture();
    expect(loadConfig({ QP_ENV: 'test', QP_QUOTA_FAILURE_MODE: 'open' }).QP_QUOTA_FAILURE_MODE).toBe('open');
    const production = { QP_ENV: 'production', GCLOUD_PROJECT: 'real-project', QP_QUEUE_ADAPTER: 'cloud',
      QP_WORKER_URL: 'https://worker.example.test', QP_TASKS_OIDC_AUDIENCE: 'https://worker.example.test',
      QP_TASKS_INVOKER_SA: 'worker@real-project.iam.gserviceaccount.com', REDIS_URL: 'rediss://redis.invalid:6380' };
    expect(() => loadConfig(production)).not.toThrow();
    expect(() => loadConfig({ ...production, QP_QUOTA_FAILURE_MODE: 'open' })).toThrow('Unsafe production configuration');
    await new RedisQuotaStore(new ManagedRedis(undefined, clock), clock, 'open').consume('alpha', 'alice', limits);
  });
});

describe('burst limits', () => {
  it('shares the Redis limit across instances and isolates scoped tenant/user keys', async () => {
    const { clock, redis } = fixture();
    const log = { warn: vi.fn() };
    const first = new RedisRateLimiter(redis, clock, 5, log);
    const second = new RedisRateLimiter(redis, clock, 5, log);
    await first.consume('["alpha","alice"]', 2);
    await second.consume('["alpha","alice"]', 2);
    await expect(first.consume('["alpha","alice"]', 2)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 50 });
    await first.consume('["beta","alice"]', 2);
    await first.consume('["alpha","bob"]', 2);
    expect(log.warn).not.toHaveBeenCalled();
  });
  it('uses floor(limit/maxInstances), remaining UTC minute and a structured degraded log', async () => {
    const { clock, connection, redis } = fixture();
    connection.mode = 'fail';
    const log = { warn: vi.fn() };
    const limiter = new RedisRateLimiter(redis, clock, 5, log);
    await limiter.consume('alpha:alice', 12);
    await limiter.consume('alpha:alice', 12);
    clock.advance(1234);
    await expect(limiter.consume('alpha:alice', 12)).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfter: 49 });
    expect(log.warn).toHaveBeenCalledWith({ code: 'ratelimit.degraded' }, expect.any(String));
    clock.advance(48_766);
    await limiter.consume('alpha:alice', 12);
    await expect(limiter.consume('small', 4)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('does not log dependency messages, URLs, passwords, tokens or descriptions', async () => {
    let output = '';
    const logger = createLogger(new Writable({ write(chunk, _, done) { output += chunk.toString(); done(); } }));
    const { clock, redis, connection } = fixture();
    connection.mode = 'fail';
    await new RedisRateLimiter(redis, clock, 5, logger).consume('key', 10);
    expect(output).toContain('ratelimit.degraded');
    expect(output).not.toMatch(/secret-password|private-host|private-password|private-token|private-description/);
  });
});

describe('metrics cache', () => {
  function metricsFixture() {
    const base = fixture();
    const metrics = vi.fn(async (tenantId: string): Promise<MetricsResponse> => ({ tenantId,
      generatedAt: new Date(base.clock.now()).toISOString(), source: 'firestore',
      counts: { ACCEPTED: tenantId === 'alpha' ? 7 : 2, PROCESSING: 0, COMPLETED: 0, FAILED: 0 }, stuck: 0 }));
    const repo = { metrics, backlog: async () => 0 } as unknown as RequestRepository;
    const cache = new RedisMetricsCache(base.redis, base.clock);
    return { ...base, metrics, cache, repo, service: new CachedMetricsService(repo, base.clock, cache) };
  }
  it('single-flights misses, hits Redis across instances, isolates tenants and never extends TTL', async () => {
    const { service, metrics, repo, cache, clock, connection } = metricsFixture();
    const values = await Promise.all(Array.from({ length: 10 }, () => service.get('alpha')));
    expect(values.every((value) => value.counts.ACCEPTED === 7)).toBe(true);
    expect(metrics).toHaveBeenCalledTimes(1);
    expect((await service.get('alpha')).source).toBe('memory');
    clock.advance(4000);
    const second = new CachedMetricsService(repo, clock, cache);
    expect((await second.get('alpha')).source).toBe('redis');
    expect((await second.get('beta')).counts.ACCEPTED).toBe(2);
    expect(connection.entries.get(metricsKey('beta'))!.until - clock.now()).toBe(5000);
    clock.advance(1000);
    expect((await second.get('alpha')).source).toBe('firestore');
    expect(metrics).toHaveBeenCalledTimes(3);
    values[0]!.counts.ACCEPTED = 999;
    expect((await service.get('alpha')).counts.ACCEPTED).toBe(7);
  });
  it('falls back to Firestore and a 5s memory cache during Redis failures', async () => {
    const { service, metrics, connection, clock } = metricsFixture();
    connection.mode = 'fail';
    expect((await service.get('alpha')).source).toBe('firestore');
    expect((await service.get('alpha')).source).toBe('memory');
    clock.advance(5000);
    await Promise.all([service.get('alpha'), service.get('alpha')]);
    expect(metrics).toHaveBeenCalledTimes(2);
  });
  it('ignores corrupted, cross-tenant, expired or excessively long-lived Redis values', async () => {
    const { service, connection, clock, metrics } = metricsFixture();
    const other = await metrics('beta');
    for (const raw of ['{', JSON.stringify({ value: other, until: clock.now() + 5000 }),
      JSON.stringify({ value: { ...other, tenantId: 'alpha' }, until: clock.now() }),
      JSON.stringify({ value: { ...other, tenantId: 'alpha' }, until: clock.now() + 5001 })]) {
      connection.entries.set(metricsKey('alpha'), { value: raw, until: clock.now() + 10_000 });
      expect((await service.get('alpha')).counts.ACCEPTED).toBe(7);
      clock.advance(5000);
    }
  });
  it('clears rejected single-flights and never caches a slow computation beyond its original TTL', async () => {
    const { service, metrics, clock, connection } = metricsFixture();
    metrics.mockRejectedValueOnce(new Error('Firestore unavailable'));
    await expect(service.get('alpha')).rejects.toThrow('Firestore unavailable');
    metrics.mockImplementationOnce(async (tenantId) => {
      clock.advance(5000);
      return { tenantId, generatedAt: new Date(clock.now()).toISOString(), source: 'firestore',
        counts: { ACCEPTED: 7, PROCESSING: 0, COMPLETED: 0, FAILED: 0 }, stuck: 0 };
    });
    await service.get('alpha');
    expect(connection.entries.has(metricsKey('alpha'))).toBe(false);
    await service.get('alpha');
    expect(metrics).toHaveBeenCalledTimes(3);
  });
});
