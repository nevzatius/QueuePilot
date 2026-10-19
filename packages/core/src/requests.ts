import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import type { Firestore, Query } from 'firebase-admin/firestore';
import {
  CreateRequestBodySchema, CorrelationIdSchema, TenantIdSchema, UidSchema, RequestSourceSchema,
  RequestStatusSchema, FailureReasonSchema, TriageResultSchema, RequestSummarySchema,
  RequestDetailSchema, RequestEventSchema, RequestIdSchema,
} from '@queuepilot/contracts';
import type { CreateRequestBody, Membership, ListRequestsQuery, ListRequestsResponse, RequestDetail, MetricsResponse } from '@queuepilot/contracts';
import { decideIdempotency, idempotencyDocId, payloadFingerprint, planAcceptance, STUCK_AFTER_MS } from '@queuepilot/domain';
import type { Clock } from '@queuepilot/domain';
import { ApiError, storageCall } from './errors.js';

const instant = z.instanceof(Timestamp);
const errorInfo = z.object({ code: z.string(), message: z.string(), at: instant });
const counter = z.number().int().nonnegative();
/** Firestore representation, shared with the future B4 adapter; timestamps remain native for indexes/TTL. */
export const StoredRequestSchema = CreateRequestBodySchema.extend({
  schemaVersion: z.literal(1), tenantId: TenantIdSchema, createdBy: UidSchema,
  status: RequestStatusSchema, statusReason: FailureReasonSchema.optional(),
  processing: z.object({ attempts: counter, maxAttempts: z.number().int().positive(), leaseId: z.string().optional(), leaseExpiresAt: instant.optional(), lastError: errorInfo.optional(), duplicateDeliveries: counter }),
  dispatch: z.object({ seq: z.number().int().positive(), maxSeq: z.number().int().positive(), deliveredSeq: counter, checks: counter, attentionSince: instant.optional(), lastError: errorInfo.optional() }),
  watchdogAt: instant.optional(), watchdogShard: z.number().int().min(0).max(3),
  rulesVersion: z.string(), result: TriageResultSchema.optional(),
  createdAt: instant, updatedAt: instant, startedAt: instant.optional(), completedAt: instant.optional(),
  correlationId: CorrelationIdSchema, source: RequestSourceSchema, expiresAt: instant.optional(),
});
export type StoredRequest = z.infer<typeof StoredRequestSchema>;
const StoredKey = z.object({ requestId: RequestIdSchema, payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/), createdAt: instant, expiresAt: instant, schemaVersion: z.literal(1) });
const StoredEvent = RequestEventSchema.omit({ at: true }).extend({ at: instant, correlationId: CorrelationIdSchema, schemaVersion: z.literal(1) });
const Cursor = z.object({ tenantId: TenantIdSchema, uid: UidSchema.nullable(), at: z.number().int().nonnegative(), nanos: counter.max(999_999_999), id: RequestIdSchema });

export type Submission = { body: CreateRequestBody; key: string; tenantId: string; uid: string; correlationId: string };
export interface RequestRepository {
  submit(input: Submission): Promise<{ requestId: string; replayed: boolean }>;
  list(membership: Membership, uid: string, query: ListRequestsQuery): Promise<ListRequestsResponse>;
  detail(membership: Membership, uid: string, requestId: string): Promise<RequestDetail>;
  metrics(tenantId: string): Promise<MetricsResponse>;
  backlog(): Promise<number>;
  health(): Promise<void>;
}

export class FirestoreRequestRepository implements RequestRepository {
  constructor(private readonly db: Firestore, private readonly clock: Clock) {}

  submit(input: Submission) {
    return storageCall(async () => {
      const fingerprint = payloadFingerprint(input.body);
      const requestId = randomUUID();
      const keyRef = this.db.doc(`idempotencyKeys/${idempotencyDocId(input.tenantId, input.uid, input.key)}`);
      // Both initial acceptance and logical-expiry takeover serialize on the same key document.
      // No queue side effect occurs inside this retried transaction.
      return this.db.runTransaction(async (tx) => {
        const snapshot = await tx.get(keyRef);
        const key = snapshot.exists ? StoredKey.parse(snapshot.data()) : null;
        const now = this.clock.now();
        const decision = decideIdempotency(key === null ? null : { ...key, createdAt: key.createdAt.toMillis(), expiresAt: key.expiresAt.toMillis() }, fingerprint, now);
        if (decision.kind === 'CONFLICT') throw new ApiError(decision.code);
        if (decision.kind === 'REPLAY') return { requestId: decision.requestId, replayed: true };
        const plan = planAcceptance({ requestId, payloadFingerprint: fingerprint, now });
        const state = plan.write.next;
        const at = Timestamp.fromMillis(now);
        const request = StoredRequestSchema.parse({
          ...input.body, tenantId: input.tenantId, createdBy: input.uid,
          status: state.status,
          processing: { attempts: state.processing.attempts, maxAttempts: state.processing.maxAttempts, duplicateDeliveries: state.processing.duplicateDeliveries },
          dispatch: { seq: state.dispatch.seq, deliveredSeq: state.dispatch.deliveredSeq, checks: state.dispatch.checks, maxSeq: state.dispatch.maxSeq },
          watchdogAt: Timestamp.fromMillis(state.watchdogAt!), watchdogShard: plan.watchdogShard,
          rulesVersion: plan.rulesVersion, correlationId: input.correlationId, source: 'api', createdAt: at, updatedAt: at, schemaVersion: 1,
        });
        const ref = this.db.doc(`requests/${requestId}`);
        tx.create(ref, request);
        const record = { ...plan.idempotency, createdAt: at, expiresAt: Timestamp.fromMillis(plan.idempotency.expiresAt), schemaVersion: 1 };
        if (decision.kind === 'CREATE') tx.create(keyRef, record);
        else tx.set(keyRef, record);
        for (const event of plan.write.events) {
          const { id, ...fields } = event;
          tx.create(ref.collection('events').doc(id), StoredEvent.parse({ ...fields, at: Timestamp.fromMillis(event.at), correlationId: input.correlationId, schemaVersion: 1 }));
        }
        return { requestId, replayed: false };
      }, { maxAttempts: 5 });
    });
  }

  list(membership: Membership, uid: string, query: ListRequestsQuery) {
    return storageCall(async () => {
      if (query.scope === 'tenant' && membership.role !== 'admin') throw new ApiError('FORBIDDEN');
      const owner = query.scope === 'mine' ? uid : null;
      let selection: Query = this.db.collection('requests').where('tenantId', '==', membership.tenantId);
      if (owner !== null) selection = selection.where('createdBy', '==', owner);
      selection = selection.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
      if (query.cursor) {
        let cursor: z.infer<typeof Cursor>;
        try { cursor = Cursor.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))); }
        catch { throw new ApiError('VALIDATION_FAILED'); }
        if (cursor.tenantId !== membership.tenantId || cursor.uid !== owner) throw new ApiError('VALIDATION_FAILED');
        // Cursor values only affect ordering, never authorization; no unscoped document fetch.
        selection = selection.startAfter(new Timestamp(cursor.at, cursor.nanos), cursor.id);
      }
      const page = await selection.limit(query.limit + 1).get();
      const docs = page.docs.slice(0, query.limit);
      const items = docs.map((doc) => summary(doc.id, StoredRequestSchema.parse(doc.data())));
      const last = docs.at(-1);
      const at = last ? StoredRequestSchema.parse(last.data()).createdAt : null;
      const nextCursor = page.size > query.limit && last && at
        ? Buffer.from(JSON.stringify({ tenantId: membership.tenantId, uid: owner, at: at.seconds, nanos: at.nanoseconds, id: last.id })).toString('base64url') : null;
      return { items, nextCursor };
    });
  }

  detail(membership: Membership, uid: string, requestId: string) {
    return storageCall(async () => {
      const ref = this.db.doc(`requests/${requestId}`);
      const doc = await ref.get();
      if (!doc.exists) throw new ApiError('NOT_FOUND');
      const stored = StoredRequestSchema.parse(doc.data());
      if (stored.tenantId !== membership.tenantId || (membership.role !== 'admin' && stored.createdBy !== uid)) throw new ApiError('NOT_FOUND');
      const timeline = await ref.collection('events').orderBy('at', 'asc').limit(200).get();
      const events = timeline.docs.map((event) => {
        const parsed = StoredEvent.parse(event.data());
        return RequestEventSchema.parse({ ...parsed, at: iso(parsed.at) });
      });
      return RequestDetailSchema.parse({
        ...summary(requestId, stored), tenantId: stored.tenantId, createdBy: stored.createdBy,
        description: stored.description, attributes: stored.attributes, source: stored.source,
        correlationId: stored.correlationId, ...(stored.startedAt && { startedAt: iso(stored.startedAt) }),
        maxAttempts: stored.processing.maxAttempts, duplicateDeliveries: stored.processing.duplicateDeliveries, events,
      });
    });
  }

  metrics(tenantId: string): Promise<MetricsResponse> {
    return storageCall(async () => {
      const selection = this.db.collection('requests').where('tenantId', '==', tenantId);
      const [accepted, processing, completed, failed, pendingAccepted, pendingProcessing] = await Promise.all([
        selection.where('status', '==', 'ACCEPTED').count().get(),
        selection.where('status', '==', 'PROCESSING').count().get(),
        selection.where('status', '==', 'COMPLETED').count().get(),
        selection.where('status', '==', 'FAILED').count().get(),
        // watchdogAt is exempt from single-field indexing. Project it from a tenant/status query;
        // avoid requiring a new composite index outside B3 ownership.
        selection.where('status', '==', 'ACCEPTED').select('watchdogAt').get(),
        selection.where('status', '==', 'PROCESSING').select('watchdogAt').get(),
      ]);
      const now = this.clock.now();
      const stuck = [...pendingAccepted.docs, ...pendingProcessing.docs].filter((doc) => {
        const at = instant.optional().parse(doc.get('watchdogAt'));
        return at !== undefined && at.toMillis() < now - STUCK_AFTER_MS;
      }).length;
      return { tenantId, generatedAt: new Date(now).toISOString(), source: 'firestore', counts: {
        ACCEPTED: accepted.data().count, PROCESSING: processing.data().count, COMPLETED: completed.data().count, FAILED: failed.data().count,
      }, stuck };
    });
  }

  backlog() { return storageCall(async () => (await this.db.collection('requests').where('status', '==', 'ACCEPTED').count().get()).data().count); }
  health() { return storageCall(async () => { await this.db.doc('tenants/sandbox').get(); }); }
}

function iso(value: Timestamp) { return value.toDate().toISOString(); }
function summary(requestId: string, stored: StoredRequest) {
  return RequestSummarySchema.parse({
    requestId, type: stored.type, title: stored.title, priority: stored.priority, status: stored.status,
    attempts: stored.processing.attempts, createdAt: iso(stored.createdAt), updatedAt: iso(stored.updatedAt),
    ...(stored.statusReason && { statusReason: stored.statusReason }), ...(stored.result && { result: stored.result }),
    ...(stored.completedAt && { completedAt: iso(stored.completedAt) }),
  });
}
