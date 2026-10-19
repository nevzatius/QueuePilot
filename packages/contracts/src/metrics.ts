import { z } from 'zod';
import { IsoTimestampSchema, TenantIdSchema } from './common.js';

const count = z.number().int().min(0);

/**
 * `GET /api/v1/metrics`: tenant-wide counts, cached for 5 s (single-flight). Only stored statuses are
 * counted: QUEUED and RETRYING need `processing.attempts`, which has no index (ARCHITECTURE §13).
 */
export const MetricsResponseSchema = z.object({
  tenantId: TenantIdSchema,
  generatedAt: IsoTimestampSchema,
  /** Where this value came from, so benchmarks can tell Redis hits from Firestore `count()` reads. */
  source: z.enum(['redis', 'memory', 'firestore']),
  counts: z.object({
    ACCEPTED: count,
    PROCESSING: count,
    COMPLETED: count,
    FAILED: count,
  }),
  /** Non-terminal requests whose watchdog is overdue by more than 15 min (reconciler down or lagging). */
  stuck: count,
});
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;
