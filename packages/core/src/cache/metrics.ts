import { MetricsResponseSchema } from '@queuepilot/contracts';
import type { MetricsResponse } from '@queuepilot/contracts';
import type { Clock } from '@queuepilot/domain';
import type { RedisAccess } from './redis.js';
import { MetricsService } from '../metrics.js';
import type { RequestRepository } from '../requests.js';

export const metricsKey = (tenantId: string) => `qp:metrics:${tenantId}`;

/** Expiry is embedded as well as enforced by Redis; a cache hit cannot renew stale data. */
export class RedisMetricsCache {
  constructor(private readonly redis: RedisAccess, private readonly clock: Clock) {}
  async get(tenantId: string): Promise<{ value: MetricsResponse; until: number } | null> {
    try {
      const raw = await this.redis.get(metricsKey(tenantId));
      if (raw === null) return null;
      const record = JSON.parse(raw) as { value?: unknown; until?: unknown };
      const value = MetricsResponseSchema.parse(record.value);
      const now = this.clock.now();
      if (value.tenantId !== tenantId || typeof record.until !== 'number'
        || !Number.isFinite(record.until) || record.until <= now || record.until > now + 5000) return null;
      return { value: { ...value, source: 'redis' }, until: record.until };
    } catch { return null; }
  }
  async put(tenantId: string, value: MetricsResponse, until: number): Promise<void> {
    const remaining = Math.min(5000, until - this.clock.now());
    if (remaining <= 0 || value.tenantId !== tenantId) return;
    try { await this.redis.set(metricsKey(tenantId), JSON.stringify({ value, until }), remaining); }
    catch { /* Firestore and the instance cache remain available. */ }
  }
}

export class CachedMetricsService extends MetricsService {
  private readonly local = new Map<string, { value: MetricsResponse; until: number }>();
  private readonly flights = new Map<string, Promise<MetricsResponse>>();
  constructor(private readonly repository: RequestRepository, private readonly time: Clock,
    private readonly cache: RedisMetricsCache) { super(repository, time); }

  override async get(tenantId: string): Promise<MetricsResponse> {
    const entry = this.local.get(tenantId);
    if (entry && this.time.now() < entry.until) return structuredClone({ ...entry.value, source: 'memory' });
    this.local.delete(tenantId);
    const pending = this.flights.get(tenantId);
    if (pending) return structuredClone(await pending);
    const flight = this.load(tenantId).finally(() => { this.flights.delete(tenantId); });
    this.flights.set(tenantId, flight);
    return structuredClone(await flight);
  }
  private async load(tenantId: string): Promise<MetricsResponse> {
    const cached = await this.cache.get(tenantId);
    if (cached) {
      this.remember(tenantId, cached);
      return cached.value;
    }
    const started = this.time.now();
    const value = await this.repository.metrics(tenantId);
    const until = started + 5000;
    this.remember(tenantId, { value, until });
    await this.cache.put(tenantId, value, until);
    return value;
  }
  private remember(tenantId: string, entry: { value: MetricsResponse; until: number }) {
    if (entry.value.tenantId !== tenantId || this.time.now() >= entry.until) return;
    if (this.local.size >= 1000) this.local.delete(this.local.keys().next().value!);
    this.local.set(tenantId, structuredClone(entry));
  }
}
