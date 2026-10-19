import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import type { TriageResult } from '@queuepilot/contracts';
import type { Clock, RequestState, StateWrite } from '@queuepilot/domain';
import { StoredRequestSchema } from '../requests.js';
import type { StoredRequest } from '../requests.js';

export type RequestIdentity = { requestId: string; tenantId: string };
export type WriteDecision = { write: StateWrite | null; result?: TriageResult };
/** Only the worker/reconciler IO seam; decisions always receive a fresh transactional document. */
export interface ProcessingStore {
  read(identity: RequestIdentity): Promise<StoredRequest | null>;
  transact<T extends WriteDecision>(identity: RequestIdentity, decide: (request: StoredRequest | null, now: number) => T): Promise<{ decision: T; request: StoredRequest | null }>;
  due(shard: number, limit: number, now: number): Promise<RequestIdentity[]>;
  health(): Promise<void>;
}

export function requestState(request: StoredRequest | null): RequestState | null {
  if (request === null) return null;
  const { processing: p, dispatch: d } = request;
  return {
    status: request.status, statusReason: request.statusReason ?? null,
    processing: { attempts: p.attempts, maxAttempts: p.maxAttempts, duplicateDeliveries: p.duplicateDeliveries,
      lease: p.leaseId && p.leaseExpiresAt ? { id: p.leaseId, expiresAt: p.leaseExpiresAt.toMillis() } : null,
      lastError: p.lastError ? { ...p.lastError, at: p.lastError.at.toMillis() } : null },
    dispatch: { ...d, attentionSince: d.attentionSince?.toMillis() ?? null,
      lastError: d.lastError ? { ...d.lastError, at: d.lastError.at.toMillis() } : null },
    watchdogAt: request.watchdogAt?.toMillis() ?? null, startedAt: request.startedAt?.toMillis() ?? null,
    completedAt: request.completedAt?.toMillis() ?? null,
  };
}

export class FirestoreProcessingStore implements ProcessingStore {
  constructor(private readonly db: Firestore, private readonly clock: Clock) {}
  async read(identity: RequestIdentity) {
    const snapshot = await this.db.doc(`requests/${identity.requestId}`).get();
    return this.scoped(snapshot.data(), identity);
  }
  async transact<T extends WriteDecision>(identity: RequestIdentity, decide: (request: StoredRequest | null, now: number) => T) {
    const ref = this.db.doc(`requests/${identity.requestId}`);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const request = this.scoped(snapshot.data(), identity);
      const now = this.clock.now();
      const decision = decide(request, now);
      if (decision.write !== null) {
        if (request === null) throw new Error('Cannot write an absent or foreign request');
        this.apply(tx, ref, request, decision, now);
      }
      return { decision, request };
    });
  }
  async due(shard: number, limit: number, now: number): Promise<RequestIdentity[]> {
    if (!Number.isInteger(shard) || shard < 0 || shard > 3 || !Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new Error('Invalid reconciler scan bounds');
    }
    const page = await this.db.collection('requests').where('watchdogShard', '==', shard)
      .where('watchdogAt', '<=', Timestamp.fromMillis(now)).orderBy('watchdogAt').limit(limit).get();
    return page.docs.map((doc) => ({ requestId: doc.id, tenantId: StoredRequestSchema.parse(doc.data()).tenantId }));
  }
  async health() { await this.db.doc('tenants/sandbox').get(); }
  private scoped(data: FirebaseFirestore.DocumentData | undefined, identity: RequestIdentity) {
    if (!data || data.tenantId !== identity.tenantId) return null;
    return StoredRequestSchema.parse(data);
  }
  private apply(tx: Transaction, ref: DocumentReference, stored: StoredRequest, decision: WriteDecision, now: number) {
    const write = decision.write!;
    const s = write.next;
    const p = s.processing;
    const d = s.dispatch;
    const instant = (value: number | null) => value === null ? FieldValue.delete() : Timestamp.fromMillis(value);
    const error = (value: typeof p.lastError) => value ? { ...value, at: Timestamp.fromMillis(value.at) } : undefined;
    // Replace the two reliability maps atomically. Omitted optional fields are removed, never stored as null.
    tx.update(ref, {
      status: s.status, statusReason: s.statusReason ?? FieldValue.delete(),
      processing: { attempts: p.attempts, maxAttempts: p.maxAttempts, duplicateDeliveries: p.duplicateDeliveries,
        ...(p.lease && { leaseId: p.lease.id, leaseExpiresAt: Timestamp.fromMillis(p.lease.expiresAt) }),
        ...(p.lastError && { lastError: error(p.lastError) }) },
      dispatch: { seq: d.seq, deliveredSeq: d.deliveredSeq, checks: d.checks, maxSeq: d.maxSeq,
        ...(d.attentionSince !== null && { attentionSince: Timestamp.fromMillis(d.attentionSince) }),
        ...(d.lastError && { lastError: error(d.lastError) }) },
      watchdogAt: instant(s.watchdogAt), startedAt: instant(s.startedAt), completedAt: instant(s.completedAt),
      updatedAt: Timestamp.fromMillis(now), ...(decision.result && { result: decision.result }),
    });
    for (const { id, at, ...event } of write.events) {
      tx.create(ref.collection('events').doc(id), { ...event, at: Timestamp.fromMillis(at),
        correlationId: stored.correlationId, schemaVersion: 1, ...(stored.expiresAt && { expiresAt: stored.expiresAt }) });
    }
  }
}
