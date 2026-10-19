import type { Clock } from '@queuepilot/domain';
import type { MetricsResponse } from '@queuepilot/contracts';
import type { RequestRepository } from './requests.js';

/** Instance fallback until the B5 Redis cache is connected. Expired data is never served. */
export class MetricsService {
  private readonly entries = new Map<string, { value: MetricsResponse; until: number }>();
  private readonly pending = new Map<string, Promise<MetricsResponse>>();
  private backlogValue: { value: number; until: number } | undefined;
  private backlogPending: Promise<number> | undefined;
  constructor(private readonly repo: RequestRepository, private readonly clock: Clock) {}
  async get(tenantId: string): Promise<MetricsResponse> {
    const entry = this.entries.get(tenantId);
    if (entry && this.clock.now() < entry.until) return { ...entry.value, source: 'memory' };
    const existing = this.pending.get(tenantId);
    if (existing) return existing;
    const operation = this.repo.metrics(tenantId).then((value) => {
      if (this.entries.size >= 1000) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(tenantId, { value, until: this.clock.now() + 5000 });
      return value;
    }).finally(() => { this.pending.delete(tenantId); });
    this.pending.set(tenantId, operation);
    return operation;
  }
  async backlog(): Promise<number> {
    if (this.backlogValue && this.clock.now() < this.backlogValue.until) return this.backlogValue.value;
    if (this.backlogPending) return this.backlogPending;
    this.backlogPending = this.repo.backlog().then((value) => {
      this.backlogValue = { value, until: this.clock.now() + 5000 };
      return value;
    }).finally(() => { this.backlogPending = undefined; });
    return this.backlogPending;
  }
}
