import { IDEMPOTENCY_WINDOW_MS } from './policy.js';
import type { EpochMs } from './time.js';

/** `idempotencyKeys/{h}` document (ARCHITECTURE §5, §9). */
export interface IdempotencyRecord {
  readonly requestId: string;
  readonly payloadFingerprint: string;
  readonly createdAt: EpochMs;
  readonly expiresAt: EpochMs;
}

export type IdempotencyDecision =
  /** S1: no record. Create the request. */
  | { readonly kind: 'CREATE' }
  /** S1: the record is logically expired. Overwrite it in a transaction and create a new request. */
  | { readonly kind: 'TAKEOVER'; readonly expiredRequestId: string }
  /** Same key and payload within the window: `202` with the original `requestId`, `Idempotent-Replayed: true`. */
  | { readonly kind: 'REPLAY'; readonly requestId: string }
  /** Same key, different payload within the window. */
  | { readonly kind: 'CONFLICT'; readonly code: 'IDEMPOTENCY_KEY_REUSED'; readonly requestId: string };

/**
 * A record is honoured strictly before `expiresAt` and is expired from `expiresAt` on (ADR-005).
 * Physical presence is irrelevant: Firestore TTL deletes asynchronously.
 */
export function isIdempotencyExpired(record: IdempotencyRecord, now: EpochMs): boolean {
  return now >= record.expiresAt;
}

/**
 * Decides a POST with an `Idempotency-Key`. Call it with the record read on the `ALREADY_EXISTS` path,
 * and again inside the takeover transaction: of two concurrent takeovers, the second re-reads the
 * winner's fresh record and gets REPLAY or CONFLICT (I2).
 */
export function decideIdempotency(
  existing: IdempotencyRecord | null,
  payloadFingerprint: string,
  now: EpochMs,
): IdempotencyDecision {
  if (existing === null) return { kind: 'CREATE' };
  if (isIdempotencyExpired(existing, now)) return { kind: 'TAKEOVER', expiredRequestId: existing.requestId };
  if (existing.payloadFingerprint === payloadFingerprint) return { kind: 'REPLAY', requestId: existing.requestId };
  return { kind: 'CONFLICT', code: 'IDEMPOTENCY_KEY_REUSED', requestId: existing.requestId };
}

export function newIdempotencyRecord(requestId: string, payloadFingerprint: string, now: EpochMs): IdempotencyRecord {
  return { requestId, payloadFingerprint, createdAt: now, expiresAt: now + IDEMPOTENCY_WINDOW_MS };
}
