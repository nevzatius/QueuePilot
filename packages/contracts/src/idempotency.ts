import { z } from 'zod';
import { HEADERS } from './http.js';

export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * `Idempotency-Key` header value (ARCHITECTURE §9): 8-128 visible ASCII characters, no whitespace.
 * The key is hashed server-side, so the character set only guards against header abuse.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(/^[\x21-\x7E]+$/, 'must contain only visible ASCII characters');

/** Header bag for POST /requests. Use as the `headers` schema of the route. */
export const IdempotencyHeadersSchema = z.object({
  [HEADERS.idempotencyKey]: IdempotencyKeySchema,
});
export type IdempotencyHeaders = z.infer<typeof IdempotencyHeadersSchema>;

/** Value of the `Idempotent-Replayed` response header on a replay. It is absent on first creation. */
export const IDEMPOTENT_REPLAYED_VALUE = 'true';
