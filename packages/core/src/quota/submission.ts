import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { CorrelationIdSchema, RequestEventSchema, RequestIdSchema } from '@queuepilot/contracts';
import { decideIdempotency, idempotencyDocId, payloadFingerprint, planAcceptance } from '@queuepilot/domain';
import type { Clock } from '@queuepilot/domain';
import { ApiError, storageCall } from '../errors.js';
import { StoredRequestSchema } from '../requests.js';
import type { Submission } from '../requests.js';
import type { Tenant } from '../membership.js';
import type { RedisLog } from '../cache/redis.js';
import type { QuotaReservation, RedisQuotaStore } from './index.js';

const StoredKey = z.object({ requestId: RequestIdSchema, payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.instanceof(Timestamp), expiresAt: z.instanceof(Timestamp), schemaVersion: z.literal(1) });
const StoredEvent = RequestEventSchema.omit({ at: true }).extend({ at: z.instanceof(Timestamp),
  correlationId: CorrelationIdSchema, schemaVersion: z.literal(1) });

export interface QuotaSubmitter {
  submit(input: Submission, tenant: Tenant): Promise<{ requestId: string; replayed: boolean }>;
}
export interface ReservableQuota {
  reserve(...args: Parameters<RedisQuotaStore['reserve']>): Promise<QuotaReservation>;
}

/** B5 acceptance IO adapter. All acceptance/idempotency decisions remain in domain.
 * The B3 repository stays unchanged; reads, metrics and processing keep using it.
 */
export class FirestoreQuotaSubmission implements QuotaSubmitter {
  constructor(private readonly db: Firestore, private readonly clock: Clock,
    private readonly quota: ReservableQuota, private readonly log: RedisLog) {}

  submit(input: Submission, tenant: Tenant) {
    return storageCall(async () => {
      const fingerprint = payloadFingerprint(input.body);
      const requestId = randomUUID();
      const keyRef = this.db.doc(`idempotencyKeys/${idempotencyDocId(input.tenantId, input.uid, input.key)}`);
      let reservation: QuotaReservation | undefined;
      let reservedDay: number | undefined;
      try {
        const accepted = await this.db.runTransaction(async (tx) => {
          const snapshot = await tx.get(keyRef);
          const key = snapshot.exists ? StoredKey.parse(snapshot.data()) : null;
          const now = this.clock.now();
          const decision = decideIdempotency(key === null ? null : { ...key,
            createdAt: key.createdAt.toMillis(), expiresAt: key.expiresAt.toMillis() }, fingerprint, now);
          if (decision.kind === 'CONFLICT') throw new ApiError(decision.code);
          if (decision.kind === 'REPLAY') return { requestId: decision.requestId, replayed: true };
          const plan = planAcceptance({ requestId, payloadFingerprint: fingerprint, now });
          const state = plan.write.next;
          const at = Timestamp.fromMillis(now);
          const request = StoredRequestSchema.parse({
            ...input.body, tenantId: input.tenantId, createdBy: input.uid, status: state.status,
            processing: { attempts: state.processing.attempts, maxAttempts: state.processing.maxAttempts,
              duplicateDeliveries: state.processing.duplicateDeliveries },
            dispatch: { seq: state.dispatch.seq, deliveredSeq: state.dispatch.deliveredSeq,
              checks: state.dispatch.checks, maxSeq: state.dispatch.maxSeq },
            watchdogAt: Timestamp.fromMillis(state.watchdogAt!), watchdogShard: plan.watchdogShard,
            rulesVersion: plan.rulesVersion, correlationId: input.correlationId, source: 'api',
            createdAt: at, updatedAt: at, schemaVersion: 1,
          });
          const ref = this.db.doc(`requests/${requestId}`);
          const events = plan.write.events.map(({ id, ...fields }) => ({ id,
            data: StoredEvent.parse({ ...fields, at: Timestamp.fromMillis(fields.at), correlationId: input.correlationId, schemaVersion: 1 }) }));
          // A retried Firestore callback reuses this operation's one reservation.
          // Replay and conflict decisions never touch Redis. Admission is still acquired by the API.
          if (tenant.quotaMode === 'enforced') {
            const day = Math.floor(now / 86_400_000);
            if (reservation && reservedDay !== day) { await reservation.cancel(); reservation = undefined; }
            reservation ??= await this.quota.reserve(input.tenantId, input.uid, tenant.limits);
            reservedDay = day;
          }
          tx.create(ref, request);
          const record = { ...plan.idempotency, createdAt: at, expiresAt: Timestamp.fromMillis(plan.idempotency.expiresAt), schemaVersion: 1 };
          if (decision.kind === 'CREATE') tx.create(keyRef, record);
          else tx.set(keyRef, record);
          for (const event of events) tx.create(ref.collection('events').doc(event.id), event.data);
          return { requestId, replayed: false };
        }, { maxAttempts: 5 });
        // A concurrent winner may turn a retried acceptance into a replay.
        if (accepted.replayed) await reservation?.cancel();
        return accepted;
      } catch (error) {
        if (reservation) {
          // Redis and Firestore cannot share a transaction. An ambiguous commit must not
          // restore budget for a request that may already have been durably accepted.
          if (definitelyUncommitted(error)) await reservation.cancel();
          else this.log.warn({ code: 'quota.reservation_retained' }, 'Quota retained after uncertain Firestore commit');
        }
        throw error;
      }
    });
  }
}

function definitelyUncommitted(error: unknown): boolean {
  if (error instanceof ApiError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' && [3, 5, 6, 7, 9, 10, 11, 12, 16].includes(code);
}
