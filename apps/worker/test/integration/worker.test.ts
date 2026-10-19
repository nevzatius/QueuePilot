import { randomUUID } from 'node:crypto';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CreateRequestBodySchema, RequestDetailSchema } from '@queuepilot/contracts';
import type { TaskPayload } from '@queuepilot/contracts';
import { decideCompletion, decideDelivery, isStuck, planAcceptance, triage, watchdogShardFor } from '@queuepilot/domain';
import type { ProcessingOutcome } from '@queuepilot/domain';
import {
  createLogger, FirestoreProcessingStore, FirestoreRequestRepository, LocalDispatchQueue, Reconciler,
  requestState, StoredRequestSchema, WorkerService,
} from '@queuepilot/core';
import type { Processor, RequestIdentity } from '@queuepilot/core';
import { buildWorkerApp } from '../../src/app.js';

// Refuse credentials and nonlocal projects; the shared emulator is never wiped.
if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('A local Firestore emulator is required');
if (process.env.GCLOUD_PROJECT !== 'demo-queuepilot') throw new Error('Use project demo-queuepilot');
const firebase = initializeApp({ projectId: 'demo-queuepilot' }, `b4-${randomUUID()}`);
const db = getFirestore(firebase);
const log = createLogger({ write: () => {} });
const body = CreateRequestBodySchema.parse({ type: 'roadside_assistance', title: 'Synthetic B4 request',
  description: 'PRIVATE SYNTHETIC DESCRIPTION', priority: 'urgent', attributes: { safetyRisk: true, locationType: 'highway' } });
const transient: ProcessingOutcome = { kind: 'TRANSIENT_ERROR', error: { code: 'TEMPORARY', message: 'Synthetic transient failure' } };
const permanent: ProcessingOutcome = { kind: 'PERMANENT_ERROR', error: { code: 'INVALID_CONTENT', message: 'Synthetic permanent failure' } };
const successful: Processor = async (request) => {
  const result = triage(request, request.rulesVersion);
  if (!result.ok) return { kind: 'PERMANENT_ERROR', error: { code: result.code, message: 'Unknown rules' } };
  return { kind: 'SUCCESS', result: result.result };
};
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(process: Processor = successful) {
  let now = Date.now() + 86_400_000;
  const clock = { now: () => now };
  const tenantId = `b4-${randomUUID().slice(0, 8)}`;
  const repo = new FirestoreRequestRepository(db, clock);
  const { requestId } = await repo.submit({ tenantId, uid: `user-${randomUUID()}`, key: randomUUID(), body, correlationId: randomUUID() });
  const payload: TaskPayload = { requestId, tenantId, seq: 1, correlationId: randomUUID() };
  const queue = new LocalDispatchQueue(clock, { environment: 'test' });
  const store = new FirestoreProcessingStore(db, clock);
  const worker = new WorkerService(store, log, process);
  const reconciler = new Reconciler(store, queue, clock, log);
  const ref = db.doc(`requests/${requestId}`);
  return { clock, repo, payload, queue, store, worker, reconciler, ref,
    state: async () => requestState(await store.read(payload))!,
    stored: async () => StoredRequestSchema.parse((await ref.get()).data()),
    advance: (ms: number) => { now += ms; }, until: (time: number) => { now = time; },
    enqueue: () => queue.enqueue(payload, new AbortController().signal),
    deliver: () => queue.pump(async (p) => (await worker.deliver(p)).http),
    events: async () => (await ref.collection('events').get()).docs.map((event) => event.data()),
  };
}
afterAll(async () => { await db.terminate(); await deleteApp(firebase); });

describe('B4 Firestore + LocalDispatchQueue (ADR-017, real transactions)', () => {
  it('T1: lost API enqueue recovers with a new committed order and completes (ADR-017 replaces same-seq retry)', async () => {
    const f = await fixture();
    f.queue.faults.create = 'fail';
    await expect(f.enqueue()).rejects.toThrow();
    expect(await f.state()).toMatchObject({ status: 'ACCEPTED', processing: { attempts: 0 }, dispatch: { seq: 1 } });
    delete f.queue.faults.create; f.advance(60_000);
    const enqueue = vi.spyOn(f.queue, 'enqueue').mockImplementation(async (payload, signal) => {
      expect((await f.state()).dispatch.seq).toBe(payload.seq); // Order is durable before IO.
      enqueue.mockRestore(); await f.queue.enqueue(payload, signal);
    });
    expect(await f.reconciler.reconcile(f.payload)).toMatchObject({ kind: 'DISPATCH', enqueue: { seq: 2 } });
    await f.deliver();
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 }, dispatch: { seq: 2, deliveredSeq: 2 } });
    expect((await f.events()).filter((event) => event.type === 'COMPLETED')).toHaveLength(1);
    // Worker writes remain readable through the unchanged B3 public contract.
    const stored = await f.stored();
    const detail = await f.repo.detail({ tenantId: f.payload.tenantId, tenantName: 'Synthetic B4 tenant', tenantStatus: 'active', role: 'member', status: 'active' }, stored.createdBy, f.payload.requestId);
    expect(RequestDetailSchema.parse(detail).result).toMatchObject({ lane: 'emergency', team: 'roadside-highway' });
  });
  it('T2: ambiguous create + EXISTS waits; exactly one completion at seq=1', async () => {
    const f = await fixture(); f.queue.faults.create = 'ambiguous';
    await expect(f.enqueue()).rejects.toThrow(); delete f.queue.faults.create;
    f.advance(60_000);
    expect((await f.reconciler.reconcile(f.payload)).kind).toBe('WAIT_FOR_TASK');
    expect((await f.state()).dispatch.seq).toBe(1);
    await f.deliver(); expect((await f.state()).status).toBe('COMPLETED');
  });
  it('T3: 500 queued tasks paused for 30m never multiply dispatches; resume completes all', async () => {
    const f = await fixture();
    const template = await f.stored();
    const payloads: TaskPayload[] = [];
    for (let offset = 0; offset < 500; offset += 100) {
      const batch = db.batch();
      for (let i = 0; i < 100; i++) {
        const requestId = randomUUID();
        const p = { ...f.payload, requestId }; payloads.push(p);
        const ref = db.doc(`requests/${requestId}`);
        batch.create(ref, { ...template, watchdogShard: watchdogShardFor(requestId) });
        const event = planAcceptance({ requestId, payloadFingerprint: 'synthetic', now: f.clock.now() }).write.events[0]!;
        const { id, at, ...fields } = event;
        batch.create(ref.collection('events').doc(id), { ...fields, at: Timestamp.fromMillis(at), correlationId: p.correlationId, schemaVersion: 1 });
      }
      await batch.commit();
    }
    await Promise.all(payloads.map((p) => f.queue.enqueue(p, new AbortController().signal)));
    f.queue.pause(); f.advance(30 * 60_000);
    expect(await f.deliver()).toBe(0);
    for (let offset = 0; offset < payloads.length; offset += 20) {
      const decisions = await Promise.all(payloads.slice(offset, offset + 20).map((p) => f.reconciler.reconcile(p)));
      expect(decisions.every((d) => d.kind === 'WAIT_FOR_TASK')).toBe(true);
    }
    expect(f.queue.size()).toBe(500); f.queue.resume();
    while (f.queue.size() > 0) { await f.deliver(); f.advance(1000); }
    for (let offset = 0; offset < payloads.length; offset += 50) {
      const states = await Promise.all(payloads.slice(offset, offset + 50).map((p) => f.store.read(p)));
      expect(states.every((s) => s?.status === 'COMPLETED' && s.dispatch.seq === 1 && s.processing.attempts === 1)).toBe(true);
    }
  }, 120_000);
  it('T4: pre-lease infrastructure exhaustion + tombstone yields seq=2, attempts=0', async () => {
    const f = await fixture(); await f.enqueue();
    for (let i = 0; i < 11; i++) { await f.queue.pump(async () => 503); f.advance(60_000); }
    expect(f.queue.size()).toBe(0);
    expect(await f.queue.probe(f.payload.requestId, 1)).toMatchObject({ result: 'NOT_FOUND' });
    expect(await f.reconciler.reconcile(f.payload)).toMatchObject({ kind: 'DISPATCH', enqueue: { seq: 2 } });
    expect(await f.state()).toMatchObject({ status: 'ACCEPTED', processing: { attempts: 0 }, dispatch: { seq: 2, deliveredSeq: 0 } });
    await f.deliver(); expect((await f.state()).status).toBe('COMPLETED');
  });
  it('T5: crash after lease gives 409 until expiry, then takeover at attempt=2', async () => {
    const f = await fixture();
    await f.store.transact(f.payload, (request, now) => decideDelivery(requestState(request), { seq: 1, leaseId: 'crashed-lease' }, now));
    expect(await f.worker.deliver(f.payload)).toEqual({ http: 409, kind: 'LEASE_HELD' });
    f.advance(60_000);
    expect(await f.worker.deliver(f.payload)).toEqual({ http: 200, kind: 'COMPLETE' });
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', processing: { attempts: 2 } });
    expect((await f.events()).filter((event) => event.type === 'LEASE_TAKEOVER')).toHaveLength(1);
  });
  it('T6: lost response after completion commit is retried and counted as a duplicate', async () => {
    const f = await fixture(); await f.enqueue();
    const original = f.store.transact.bind(f.store);
    let calls = 0;
    const spy = vi.spyOn(f.store, 'transact').mockImplementation(async (identity, decide) => {
      const result = await original(identity, decide);
      if (++calls === 2) throw new Error('crash after commit');
      return result;
    });
    await f.deliver(); spy.mockRestore();
    expect((await f.state()).status).toBe('COMPLETED'); expect(f.queue.size()).toBe(1);
    f.advance(2000); await f.deliver();
    expect((await f.state()).processing.duplicateDeliveries).toBe(1); expect(f.queue.size()).toBe(0);
  });
  it('T7: transient final attempt fails ATTEMPTS_EXHAUSTED; Firestore alone counts attempts', async () => {
    const f = await fixture(async () => transient);
    for (let i = 0; i < 4; i++) expect((await f.worker.deliver(f.payload)).http).toBe(503);
    expect(await f.worker.deliver(f.payload)).toEqual({ http: 200, kind: 'FAIL' });
    expect(await f.state()).toMatchObject({ status: 'FAILED', statusReason: 'ATTEMPTS_EXHAUSTED', processing: { attempts: 5 }, watchdogAt: null });
    expect((await f.events()).filter((event) => event.type === 'FAILED')).toHaveLength(1);
  });
  it('T8/T9: concurrent stale and current wakeups share one lease and exactly one COMPLETED', async () => {
    const entered = latch(); const release = latch();
    const f = await fixture(async (...args) => { entered.resolve(); await release.promise; return successful(...args); });
    await f.ref.update({ 'dispatch.seq': 3 });
    const first = f.worker.deliver(f.payload); await entered.promise;
    try {
      const responses = await Promise.all([f.worker.deliver({ ...f.payload, seq: 2 }), f.worker.deliver({ ...f.payload, seq: 3 })]);
      expect(responses).toEqual([{ http: 409, kind: 'LEASE_HELD' }, { http: 409, kind: 'LEASE_HELD' }]);
    } finally { release.resolve(); }
    expect(await first).toEqual({ http: 200, kind: 'COMPLETE' });
    expect(await f.worker.deliver({ ...f.payload, seq: 2 })).toEqual({ http: 200, kind: 'DUPLICATE_SUPPRESSED' });
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1, duplicateDeliveries: 1 }, dispatch: { seq: 3, deliveredSeq: 1 } });
    expect((await f.events()).filter((event) => event.type === 'COMPLETED')).toHaveLength(1);
  });
  it('T10: a late completion cannot overwrite the replacement lease or its result', async () => {
    const entered = latch(); const release = latch(); let starts = 0;
    const f = await fixture(async (...args) => { if (++starts === 1) { entered.resolve(); await release.promise; return permanent; } return successful(...args); });
    const late = f.worker.deliver(f.payload); await entered.promise;
    try {
      f.advance(60_000);
      expect(await f.worker.deliver(f.payload)).toEqual({ http: 200, kind: 'COMPLETE' });
    } finally { release.resolve(); }
    expect(await late).toEqual({ http: 200, kind: 'FENCED' });
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', statusReason: null, processing: { attempts: 2 } });
    expect((await f.events()).filter((event) => event.type === 'FAILED')).toHaveLength(0);
  });
  it('T10: lease mismatch while the new holder is still processing returns 409 with no write', async () => {
    const f = await fixture();
    await f.store.transact(f.payload, (request, now) => decideDelivery(requestState(request), { seq: 1, leaseId: 'new-holder' }, now));
    const before = await f.stored();
    const fenced = await f.store.transact(f.payload, (request, now) => decideCompletion(requestState(request), 'old-holder', permanent, now));
    expect(fenced.decision).toMatchObject({ kind: 'FENCED', http: 409, reason: 'LEASE_MISMATCH', write: null });
    expect(await f.stored()).toEqual(before);
  });
  it('T11: two real concurrent reconcilers commit at most one order per due watchdog', async () => {
    const f = await fixture(); f.advance(60_000);
    const second = new Reconciler(f.store, f.queue, f.clock, log);
    const results = await Promise.all([f.reconciler.reconcile(f.payload), second.reconcile(f.payload)]);
    expect(results.filter((d) => d.kind === 'DISPATCH')).toHaveLength(1);
    expect((await f.state()).dispatch.seq).toBe(2); expect(f.queue.size()).toBe(1);
    const again = await Promise.all([f.reconciler.reconcile(f.payload), second.reconcile(f.payload)]);
    expect(again.every((d) => d.kind === 'NOOP')).toBe(true);
  });
  it('T12: without reconciler a lost enqueue stays ACCEPTED and stuck; next pass recovers it', async () => {
    const f = await fixture(); f.advance(16 * 60_000 + 1);
    expect(isStuck(await f.state(), f.clock.now())).toBe(true);
    expect((await f.state()).status).toBe('ACCEPTED');
    await f.reconciler.reconcile(f.payload); await f.deliver();
    expect((await f.state()).status).toBe('COMPLETED');
  });
  it('T13: permanent processing error fails on attempt 1 and is absorbing', async () => {
    const f = await fixture(async () => permanent);
    expect(await f.worker.deliver(f.payload)).toEqual({ http: 200, kind: 'FAIL' });
    expect(await f.state()).toMatchObject({ status: 'FAILED', statusReason: 'PERMANENT_ERROR', processing: { attempts: 1 } });
    await f.worker.deliver(f.payload); await f.reconciler.reconcile(f.payload);
    expect(await f.state()).toMatchObject({ status: 'FAILED', processing: { attempts: 1, duplicateDeliveries: 1 } });
  });
  it.each([1, 3])('stalled creator at seq=%s creates late after a newer order, safely past maxSeq', async (initialSeq) => {
    const f = await fixture(); await f.ref.update({ 'dispatch.seq': initialSeq }); f.advance(60_000);
    const entered = latch(); const release = latch(); const created = latch();
    const enqueue = f.queue.enqueue.bind(f.queue);
    const spy = vi.spyOn(f.queue, 'enqueue').mockImplementationOnce(async (p) => {
      // Like a stalled SDK/network call, this creator can finish after cancellation.
      entered.resolve(); await release.promise; await enqueue(p, new AbortController().signal); created.resolve();
    });
    const stalled = f.reconciler.reconcile(f.payload); await entered.promise;
    try {
      const state = await f.state(); expect(state.dispatch.seq).toBe(initialSeq + 1);
      f.until(state.watchdogAt!); await new Reconciler(f.store, f.queue, f.clock, log).reconcile(f.payload);
      expect((await f.state()).dispatch.seq).toBe(initialSeq + 2);
    } finally { release.resolve(); }
    await created.promise; await stalled; spy.mockRestore();
    expect(f.queue.size()).toBe(2); await f.deliver();
    if (f.queue.size()) { f.advance(2000); await f.deliver(); }
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 }, dispatch: { attentionSince: null } });
    expect((await f.events()).filter((event) => event.type === 'COMPLETED')).toHaveLength(1);
  });
  it('delayed createTask after completion is absorbed; enqueue diagnostics cannot resurrect state', async () => {
    const f = await fixture(); f.advance(60_000);
    const entered = latch(); const release = latch(); const created = latch(); const original = f.queue.enqueue.bind(f.queue);
    const spy = vi.spyOn(f.queue, 'enqueue').mockImplementationOnce(async (p) => {
      entered.resolve(); await release.promise; await original(p, new AbortController().signal); created.resolve();
    });
    const pending = f.reconciler.reconcile(f.payload); await entered.promise;
    try { await f.worker.deliver(f.payload); } finally { release.resolve(); }
    await created.promise; await pending; spy.mockRestore(); await f.deliver();
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1, duplicateDeliveries: 1 }, dispatch: { seq: 2, lastError: null } });
  });
  it('queue outage enters attention with 5m/30m order cadence, never FAILED; recovery clears attention', async () => {
    const f = await fixture(); f.queue.faults.create = 'fail'; f.advance(60_000);
    for (let i = 0; i < 7; i++) {
      const before = await f.state(); const orderedAt = f.clock.now();
      expect((await f.reconciler.reconcile(f.payload)).kind).toBe('DISPATCH');
      const after = await f.state();
      expect(after.status).toBe('ACCEPTED'); expect(after.processing.attempts).toBe(0);
      expect(after.dispatch.lastError?.code).toBe('ENQUEUE_FAILED');
      expect(after.watchdogAt! - orderedAt).toBe(before.dispatch.seq >= 3 ? 1_800_000 : 300_000);
      expect((await f.reconciler.reconcile(f.payload)).kind).toBe('NOOP'); f.until(after.watchdogAt!);
    }
    expect((await f.state()).dispatch.attentionSince).not.toBeNull();
    expect((await f.events()).filter((e) => e.type === 'FAILED')).toHaveLength(0);
    delete f.queue.faults.create; await f.reconciler.reconcile(f.payload); await f.deliver();
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', dispatch: { attentionSince: null } });
  });
  it.each(['EXISTS', 'NOT_FOUND', 'UNKNOWN', 'PERMISSION_DENIED'] as const)('lying probe %s only changes load; never failure or budget', async (probe) => {
    const f = await fixture(); await f.enqueue(); f.advance(60_000);
    if (probe === 'PERMISSION_DENIED') f.queue.faults.permissionDenied = true; else f.queue.faults.probe = probe;
    expect((await f.reconciler.reconcile(f.payload)).kind).toBe(probe === 'EXISTS' ? 'WAIT_FOR_TASK' : 'DISPATCH');
    expect((await f.state()).processing.attempts).toBe(0);
    await f.deliver(); if (f.queue.size()) { f.advance(2000); await f.deliver(); }
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 } });
  });
  it('a lying EXISTS for an absent task delays an order; a later UNKNOWN hint recovers safely', async () => {
    const f = await fixture(); f.queue.faults.probe = 'EXISTS'; f.advance(60_000);
    expect((await f.reconciler.reconcile(f.payload)).kind).toBe('WAIT_FOR_TASK');
    const waiting = await f.state(); expect(waiting.dispatch.seq).toBe(1); expect(f.queue.size()).toBe(0);
    f.until(waiting.watchdogAt!); f.queue.faults.probe = 'UNKNOWN';
    await f.reconciler.reconcile(f.payload); await f.deliver();
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 } });
  });
  it('a probe stalled across a newer order is ignored even after the new watchdog becomes due', async () => {
    const f = await fixture(); f.advance(60_000);
    const entered = latch(); const release = latch();
    const original = f.queue.probe.bind(f.queue);
    const spy = vi.spyOn(f.queue, 'probe').mockImplementationOnce(async (id, seq) => {
      const result = await original(id, seq); entered.resolve(); await release.promise; return result;
    });
    const stale = f.reconciler.reconcile(f.payload); await entered.promise;
    try {
      await new Reconciler(f.store, f.queue, f.clock, log).reconcile(f.payload);
      f.until((await f.state()).watchdogAt!);
    } finally { release.resolve(); }
    expect((await stale).kind).toBe('PROBE_STALE'); spy.mockRestore();
    expect((await f.state()).dispatch.seq).toBe(2); expect(f.queue.size()).toBe(1);
    await f.deliver(); expect((await f.state()).status).toBe('COMPLETED');
  });
  it('crash between order commit and createTask recovers on the next watchdog', async () => {
    const f = await fixture(); f.advance(60_000);
    // Interrupt exactly after the real order transaction commits, before its caller sees the result.
    const transact = f.store.transact.bind(f.store);
    const spy = vi.spyOn(f.store, 'transact').mockImplementationOnce(async (identity, decide) => {
      const result = await transact(identity, decide); throw new Error(`crash after ${result.decision.write?.transition}`);
    });
    await expect(f.reconciler.reconcile(f.payload)).rejects.toThrow('crash after S9'); spy.mockRestore();
    expect(f.queue.size()).toBe(0); const state = await f.state(); expect(state.dispatch.seq).toBe(2);
    f.until(state.watchdogAt!); await f.reconciler.reconcile(f.payload); await f.deliver();
    expect(await f.state()).toMatchObject({ status: 'COMPLETED', dispatch: { seq: 3 }, processing: { attempts: 1 } });
  });
  it('S8: expired final lease is failed by reconciler without dispatch or another business start', async () => {
    const f = await fixture(); await f.ref.update({ 'processing.attempts': 4 });
    await f.store.transact(f.payload, (request, now) => decideDelivery(requestState(request), { seq: 1, leaseId: 'final-crash' }, now));
    f.advance(90_000); expect((await f.reconciler.reconcile(f.payload)).kind).toBe('FAIL');
    expect(await f.state()).toMatchObject({ status: 'FAILED', statusReason: 'ATTEMPTS_EXHAUSTED', processing: { attempts: 5 } });
    expect(f.queue.size()).toBe(0);
  });
  it('worker/reconciler reads are tenant isolated; future and orphan deliveries do no writes', async () => {
    const f = await fixture(); const before = await f.stored();
    expect(await f.worker.deliver({ ...f.payload, tenantId: 'foreign-tenant' })).toEqual({ http: 200, kind: 'ORPHAN' });
    expect(await f.store.read({ ...f.payload, tenantId: 'foreign-tenant' })).toBeNull();
    expect((await f.reconciler.reconcile({ ...f.payload, tenantId: 'foreign-tenant' })).kind).toBe('NOOP');
    expect(await f.worker.deliver({ ...f.payload, seq: 2 })).toEqual({ http: 200, kind: 'FUTURE_DISPATCH' });
    expect(await f.worker.deliver({ ...f.payload, requestId: randomUUID() })).toEqual({ http: 200, kind: 'ORPHAN' });
    expect(await f.stored()).toEqual(before);
  });
  it('private HTTP validates TaskPayload, ignores queue retry budgets and waits for durable completion', async () => {
    const f = await fixture();
    const app = buildWorkerApp({ verifier: { verify: async (header) => header === 'Bearer test-only' },
      store: f.store, worker: f.worker, reconciler: f.reconciler, logger: false });
    try {
      for (const url of ['/internal/tasks', '/internal/reconcile']) expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url: '/internal/tasks', headers: { authorization: 'Bearer test-only' }, payload: { ...f.payload, seq: 0 } })).statusCode).toBe(400);
      const response = await app.inject({ method: 'POST', url: '/internal/tasks', headers: {
        authorization: 'Bearer test-only', 'x-cloudtasks-taskretrycount': '999999', 'x-cloudtasks-taskexecutioncount': '999999',
      }, payload: f.payload });
      expect(response.statusCode).toBe(200); expect(await f.state()).toMatchObject({ status: 'COMPLETED', processing: { attempts: 1 } });
      expect((await app.inject({ url: '/ready' })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
  it('completion commit failure returns 503; request remains leased until retry/takeover', async () => {
    const f = await fixture();
    const original = f.store.transact.bind(f.store); let calls = 0;
    vi.spyOn(f.store, 'transact').mockImplementation(async (identity, decide) => {
      if (++calls === 2) throw new Error('commit failed'); return original(identity, decide);
    });
    const app = buildWorkerApp({ verifier: { verify: async () => true }, store: f.store, worker: f.worker, reconciler: f.reconciler, logger: false });
    try {
      const response = await app.inject({ method: 'POST', url: '/internal/tasks', payload: f.payload });
      expect(response.statusCode).toBe(503);
      expect((await f.state()).status).toBe('PROCESSING');
    } finally { await app.close(); }
  });
  it('bounded indexed scan selects at most 25 per shard and rechecks fresh state', async () => {
    const f = await fixture(); f.advance(60_000);
    for (let shard = 0; shard < 4; shard++) {
      const due: RequestIdentity[] = await f.store.due(shard, 25, f.clock.now());
      expect(due.length).toBeLessThanOrEqual(25);
      for (const id of due) {
        const stored = await f.store.read(id); expect(stored?.watchdogShard).toBe(shard);
        expect(stored?.watchdogAt!.toMillis()).toBeLessThanOrEqual(f.clock.now());
      }
    }
    await expect(f.store.due(4, 25, f.clock.now())).rejects.toThrow();
    await expect(f.store.due(0, 26, f.clock.now())).rejects.toThrow();
  });
});
