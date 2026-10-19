import { z } from 'zod';
import { CorrelationIdSchema, RequestIdSchema, TenantIdSchema } from './common.js';

/**
 * Cloud Tasks HTTP body for `r-{requestId}-{seq}` (ARCHITECTURE §8). The worker uses `seq` for the
 * stale-delivery check; budgets come from Firestore, never from Cloud Tasks headers (I5).
 */
export const TaskPayloadSchema = z.strictObject({
  requestId: RequestIdSchema,
  tenantId: TenantIdSchema,
  seq: z.number().int().min(1),
  correlationId: CorrelationIdSchema,
});
export type TaskPayload = z.infer<typeof TaskPayloadSchema>;
