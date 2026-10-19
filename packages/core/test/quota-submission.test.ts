import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, FirestoreQuotaSubmission, ManagedRedis, RedisQuotaStore } from '../src/index.js';
import type { Submission, Tenant } from '../src/index.js';
import { FakeClock, RedisDouble } from '../../../tests/unit/redis-double.js';

type Document = Record<string, unknown>;
class Reference {
  constructor(readonly path: string) {}
  collection(name: string) { return { doc: (id: string) => new Reference(`${this.path}/${name}/${id}`) }; }
}
type Write = { kind: 'create' | 'set'; ref: Reference; value: Document };
type Transaction = {
  get(ref: Reference): Promise<{ exists: boolean; data(): Document | undefined }>;
  create(ref: Reference, value: Document): void;
  set(ref: Reference, value: Document): void;
};
class FirestoreDouble {
  readonly documents = new Map<string, Document>();
  readonly trace: string[] = [];
  readonly attempts: Write[][] = [];
  retry = false;
  afterFirst: ((writes: Write[]) => void) | undefined;
  failure: number | undefined;
  doc(path: string) { return new Reference(path); }
  async runTransaction<T>(work: (tx: Transaction) => Promise<T>, options: { maxAttempts: number }): Promise<T> {
    expect(options.maxAttempts).toBe(5);
    let result!: T;
    for (let attempt = 0; attempt < (this.retry ? 2 : 1); attempt++) {
      const writes: Write[] = [];
      this.attempts.push(writes);
      result = await work({
        get: async (ref) => { this.trace.push('read'); return { exists: this.documents.has(ref.path), data: () => this.documents.get(ref.path) }; },
        create: (ref, value) => { this.trace.push('write'); writes.push({ kind: 'create', ref, value }); },
        set: (ref, value) => { this.trace.push('write'); writes.push({ kind: 'set', ref, value }); },
      });
      if (attempt === 0 && this.retry) { this.afterFirst?.(writes); continue; }
      if (this.failure !== undefined) throw Object.assign(new Error('Storage commit failed'), { code: this.failure });
      for (const write of writes) this.documents.set(write.ref.path, write.value);
    }
    return result;
  }
}

const tenant: Tenant = { name: 'Synthetic tenant', status: 'active', openSignup: true, quotaMode: 'enforced', schemaVersion: 1,
  limits: { submitPerMin: 10, submitPerDayUser: 3, submitPerDayTenant: 5 } };
const input: Submission = { tenantId: 'alpha', uid: 'alice', key: 'idempotency-key', correlationId: 'synthetic-correlation',
  body: { type: 'general', title: 'Synthetic request', description: '', priority: 'normal', attributes: {} } };
function fixture() {
  const clock = new FakeClock();
  const db = new FirestoreDouble();
  const connection = new RedisDouble(clock);
  const quota = new RedisQuotaStore(new ManagedRedis(connection, clock), clock);
  const reserve = vi.spyOn(quota, 'reserve');
  const log = { warn: vi.fn() };
  const service = new FirestoreQuotaSubmission(db as unknown as Firestore, clock, quota, log);
  return { clock, db, connection, quota, reserve, log, service };
}

describe('quota-aware Firestore acceptance IO', () => {
  it('reads the durable key, reserves before writes and preserves the B3 acceptance plan', async () => {
    const { service, db, reserve } = fixture();
    reserve.mockImplementationOnce(async () => {
      expect(db.trace).toEqual(['read']);
      return { cancel: async () => {} };
    });
    const accepted = await service.submit(input, tenant);
    expect(accepted.replayed).toBe(false);
    expect(reserve).toHaveBeenCalledOnce();
    expect(db.documents.get(`requests/${accepted.requestId}`)).toMatchObject({ tenantId: 'alpha', createdBy: 'alice',
      status: 'ACCEPTED', dispatch: { seq: 1, deliveredSeq: 0 }, processing: { attempts: 0 } });
    expect(db.documents.has(`requests/${accepted.requestId}/events/ACCEPTED-s1`)).toBe(true);
  });
  it('does not consume quota on replay/conflict, including while Redis is down', async () => {
    const { service, connection, reserve } = fixture();
    const first = await service.submit(input, tenant);
    connection.mode = 'fail';
    expect(await service.submit(input, tenant)).toEqual({ ...first, replayed: true });
    await expect(service.submit({ ...input, body: { ...input.body, title: 'Changed request' } }, tenant))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(reserve).toHaveBeenCalledOnce();
  });
  it('reserves once over transaction retries and refunds a concurrent winner replay', async () => {
    const { service, db, reserve, connection } = fixture();
    db.retry = true;
    db.afterFirst = (writes) => {
      const key = writes.find((write) => write.ref.path.startsWith('idempotencyKeys/'))!;
      db.documents.set(key.ref.path, key.value);
    };
    expect((await service.submit(input, tenant)).replayed).toBe(true);
    expect(reserve).toHaveBeenCalledOnce();
    expect([...connection.entries.values()].filter((entry) => entry.value === '1')).toHaveLength(0);
    expect(db.attempts[1]).toHaveLength(0);
  });
  it('reserves once for retried acceptance and never writes on quota denial', async () => {
    const { service, db, reserve } = fixture();
    db.retry = true;
    expect((await service.submit(input, tenant)).replayed).toBe(false);
    expect(reserve).toHaveBeenCalledOnce();
    const failed = fixture();
    failed.reserve.mockRejectedValue(new ApiError('QUOTA_UNAVAILABLE', 30));
    await expect(failed.service.submit(input, tenant)).rejects.toMatchObject({ code: 'QUOTA_UNAVAILABLE' });
    expect(failed.db.trace).toEqual(['read']);
    expect(failed.db.documents.size).toBe(0);
  });
  it('refunds confirmed aborted commits but retains budget for uncertain commits', async () => {
    for (const code of [10, 14]) {
      const { service, db, connection, log } = fixture();
      db.failure = code;
      await expect(service.submit(input, tenant)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      const counters = [...connection.entries].filter(([key]) => !key.includes(':reservation:'));
      expect(counters.map(([, entry]) => entry.value)).toEqual(code === 10 ? ['0', '0'] : ['1', '1']);
      expect(log.warn).toHaveBeenCalledTimes(code === 10 ? 0 : 1);
    }
  });
  it('does not depend on Redis for quotaMode=none and uses logical expiry for takeover', async () => {
    const { service, clock, reserve, db, connection } = fixture();
    connection.mode = 'fail';
    const first = await service.submit(input, { ...tenant, quotaMode: 'none' });
    expect(reserve).not.toHaveBeenCalled();
    connection.mode = 'healthy';
    clock.advance(86_400_000);
    const second = await service.submit(input, tenant);
    expect(second.replayed).toBe(false);
    expect(second.requestId).not.toBe(first.requestId);
    expect(reserve).toHaveBeenCalledOnce();
    expect(db.attempts[1]!.some((write) => write.kind === 'set' && write.value.expiresAt instanceof Timestamp)).toBe(true);
  });
  it('changes the reserved UTC day when a retry crosses midnight', async () => {
    const { service, clock, reserve, db, connection } = fixture();
    db.retry = true;
    db.afterFirst = () => { clock.value = Date.UTC(2026, 9, 21); };
    await service.submit(input, tenant);
    expect(reserve).toHaveBeenCalledTimes(2);
    const counters = [...connection.entries].filter(([key]) => !key.includes(':reservation:'));
    expect(counters.filter(([key]) => key.includes('2026-10-20')).map(([, entry]) => entry.value)).toEqual(['0', '0']);
    expect(counters.filter(([key]) => key.includes('2026-10-21')).map(([, entry]) => entry.value)).toEqual(['1', '1']);
  });
});
