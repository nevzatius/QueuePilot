import { z } from 'zod';
import {
  CorrelationIdSchema,
  IsoTimestampSchema,
  RequestIdSchema,
  TenantIdSchema,
  UidSchema,
} from './common.js';
import { PageQuerySchema, pageOf } from './http.js';
import { FailureReasonSchema, RequestStatusSchema } from './status.js';
import type { FailureReason, RequestStatus } from './status.js';

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const REQUEST_TYPES = ['maintenance', 'it_support', 'facilities', 'other'] as const;
export const RequestTypeSchema = z.enum(REQUEST_TYPES);
export type RequestType = z.infer<typeof RequestTypeSchema>;

export const PrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type Priority = z.infer<typeof PrioritySchema>;

/** Triage inputs besides `priority` (ARCHITECTURE §17). Strict, so the stored attributes stay bounded. */
export const RequestAttributesSchema = z.strictObject({
  safetyRisk: z.enum(['none', 'low', 'high']).optional(),
  locationType: z.enum(['indoor', 'outdoor', 'remote']).optional(),
  preferredWindow: z.enum(['morning', 'afternoon', 'evening', 'anytime']).optional(),
});
export type RequestAttributes = z.infer<typeof RequestAttributesSchema>;

/**
 * Body of `POST /api/v1/requests`. Strict on purpose: unknown keys such as `tenantId` or `createdBy`
 * are rejected instead of ignored. The idempotency fingerprint is computed over the parsed output,
 * so omitted defaults and explicit defaults hash identically.
 */
export const CreateRequestBodySchema = z.strictObject({
  type: RequestTypeSchema,
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).default(''),
  priority: PrioritySchema.default('normal'),
  attributes: RequestAttributesSchema.default({}),
});
export type CreateRequestBody = z.output<typeof CreateRequestBodySchema>;
export type CreateRequestInput = z.input<typeof CreateRequestBodySchema>;

/** `202 Accepted`: the request is durably stored and will be processed at least once. */
export const CreateRequestResponseSchema = z.object({
  requestId: RequestIdSchema,
  location: z.string().min(1).max(256),
});
export type CreateRequestResponse = z.infer<typeof CreateRequestResponseSchema>;

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Deterministic triage output (ARCHITECTURE §17, I6). */
export const TriageResultSchema = z.object({
  rulesVersion: z.string().min(1).max(32),
  lane: z.enum(['URGENT', 'STANDARD', 'SCHEDULED']),
  slaTargetMinutes: z.number().int().positive().max(525_600),
  team: z.string().min(1).max(64),
  score: z.number().int().min(0).max(100),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

export const REQUEST_SOURCES = ['ui', 'api', 'loadtest'] as const;
export const RequestSourceSchema = z.enum(REQUEST_SOURCES);

/**
 * Cross-field rules every request view must satisfy:
 * `statusReason` iff FAILED, `result` only when COMPLETED, `completedAt` only in a terminal state.
 */
function checkStatusConsistency(
  v: { status: RequestStatus; statusReason?: FailureReason | undefined; result?: unknown; completedAt?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (v.status === 'FAILED' && v.statusReason === undefined) {
    ctx.addIssue({ code: 'custom', path: ['statusReason'], message: 'required when status is FAILED' });
  }
  if (v.status !== 'FAILED' && v.statusReason !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['statusReason'], message: 'allowed only when status is FAILED' });
  }
  if (v.status !== 'COMPLETED' && v.result !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['result'], message: 'allowed only when status is COMPLETED' });
  }
  const terminal = v.status === 'COMPLETED' || v.status === 'FAILED';
  if (!terminal && v.completedAt !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['completedAt'], message: 'allowed only in a terminal status' });
  }
}

const summaryShape = {
  requestId: RequestIdSchema,
  type: RequestTypeSchema,
  title: z.string().min(1).max(120),
  priority: PrioritySchema,
  status: RequestStatusSchema,
  statusReason: FailureReasonSchema.optional(),
  /** Business-logic starts so far. The UI derives QUEUED/RETRYING from it (see `deriveDisplayStatus`). */
  attempts: z.number().int().min(0),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.optional(),
  result: TriageResultSchema.optional(),
};

/** List item. */
export const RequestSummarySchema = z.object(summaryShape).superRefine(checkStatusConsistency);
export type RequestSummary = z.infer<typeof RequestSummarySchema>;

export const REQUEST_EVENT_TYPES = [
  'ACCEPTED',
  'PROCESSING_STARTED',
  'LEASE_TAKEOVER',
  'RETRY_SCHEDULED',
  'REDISPATCHED',
  'COMPLETED',
  'FAILED',
] as const;
export const RequestEventTypeSchema = z.enum(REQUEST_EVENT_TYPES);
export type RequestEventType = z.infer<typeof RequestEventTypeSchema>;

/** Timeline entry. Event IDs are deterministic server-side and are not part of the contract. */
export const RequestEventSchema = z.object({
  type: RequestEventTypeSchema,
  at: IsoTimestampSchema,
  actor: z.enum(['api', 'worker', 'reconciler', 'admin']),
  attempt: z.number().int().min(0),
  seq: z.number().int().min(1),
  details: z.record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean(), z.null()])).optional(),
});
export type RequestEvent = z.infer<typeof RequestEventSchema>;

/** `GET /api/v1/requests/{requestId}`. */
export const RequestDetailSchema = z
  .object({
    ...summaryShape,
    tenantId: TenantIdSchema,
    createdBy: UidSchema,
    description: z.string().max(2000),
    attributes: RequestAttributesSchema,
    source: RequestSourceSchema,
    correlationId: CorrelationIdSchema,
    startedAt: IsoTimestampSchema.optional(),
    maxAttempts: z.number().int().positive(),
    duplicateDeliveries: z.number().int().min(0),
    events: z.array(RequestEventSchema).max(200),
  })
  .superRefine(checkStatusConsistency);
export type RequestDetail = z.infer<typeof RequestDetailSchema>;

export const RequestIdParamsSchema = z.object({ requestId: RequestIdSchema });

/**
 * `GET /api/v1/requests` query. `scope=mine` (default) lists the caller's requests; `scope=tenant`
 * is admin-only and answers `403 FORBIDDEN` for members. Results are ordered by `createdAt` descending.
 * There is no status filter: no index backs it (ARCHITECTURE §13), so clients filter on the page.
 */
export const ListRequestsQuerySchema = PageQuerySchema.extend({
  scope: z.enum(['mine', 'tenant']).default('mine'),
});
export type ListRequestsQuery = z.infer<typeof ListRequestsQuerySchema>;

export const ListRequestsResponseSchema = pageOf(RequestSummarySchema);
export type ListRequestsResponse = z.infer<typeof ListRequestsResponseSchema>;
