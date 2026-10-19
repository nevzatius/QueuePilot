import { describe, expect, it } from 'vitest';
import {
  ListRequestsQuerySchema,
  ListRequestsResponseSchema,
  RequestDetailSchema,
  RequestIdParamsSchema,
  RequestSummarySchema,
  requestPath,
} from '../src/index.js';

const requestId = '3f2b8c1e-6a4d-4f0b-9c1d-2e7a5b8c9d01';
const t0 = '2026-10-20T09:00:00.000Z';
const t1 = '2026-10-20T09:00:05.250Z';
const result = { rulesVersion: 'v1', lane: 'URGENT', slaTargetMinutes: 60, team: 'facilities-a', score: 87 } as const;

const accepted = {
  requestId,
  type: 'maintenance',
  title: 'Leaking pipe',
  priority: 'high',
  status: 'ACCEPTED',
  attempts: 0,
  createdAt: t0,
  updatedAt: t0,
} as const;
const completed = { ...accepted, status: 'COMPLETED', attempts: 1, updatedAt: t1, completedAt: t1, result } as const;
const failed = { ...accepted, status: 'FAILED', statusReason: 'ATTEMPTS_EXHAUSTED', attempts: 5, completedAt: t1 } as const;

describe('RequestSummarySchema', () => {
  it.each([
    ['ACCEPTED', accepted],
    ['PROCESSING', { ...accepted, status: 'PROCESSING', attempts: 1 }],
    ['COMPLETED with result', completed],
    ['FAILED with reason', failed],
  ])('accepts %s', (_name, body) => {
    expect(RequestSummarySchema.safeParse(body).success).toBe(true);
  });

  const invalid: Array<[string, unknown]> = [
    ['FAILED without statusReason', { ...failed, statusReason: undefined }],
    ['statusReason on a non-FAILED request', { ...completed, statusReason: 'PERMANENT_ERROR' }],
    ['unknown statusReason', { ...failed, statusReason: 'BAD_LUCK' }],
    ['result on a non-COMPLETED request', { ...accepted, result }],
    ['completedAt on a non-terminal request', { ...accepted, completedAt: t1 }],
    ['derived status stored (QUEUED)', { ...accepted, status: 'QUEUED' }],
    ['negative attempts', { ...accepted, attempts: -1 }],
    ['fractional attempts', { ...accepted, attempts: 1.5 }],
    ['timestamp without Z', { ...accepted, createdAt: '2026-10-20 09:00:00' }],
    ['timestamp with offset', { ...accepted, createdAt: '2026-10-20T09:00:00+02:00' }],
    ['non-v4 requestId', { ...accepted, requestId: 'not-a-uuid' }],
    ['score out of range', { ...completed, result: { ...result, score: 101 } }],
    ['unknown lane', { ...completed, result: { ...result, lane: 'FAST' } }],
    ['missing createdAt', { ...accepted, createdAt: undefined }],
  ];
  it.each(invalid)('rejects %s', (_name, body) => {
    expect(RequestSummarySchema.safeParse(body).success).toBe(false);
  });
});

describe('RequestDetailSchema', () => {
  const detail = {
    ...completed,
    tenantId: 'sandbox',
    createdBy: 'uid-1',
    description: 'Water under the sink',
    attributes: { safetyRisk: 'low' },
    source: 'ui',
    correlationId: 'corr-1234',
    startedAt: t0,
    maxAttempts: 5,
    duplicateDeliveries: 0,
    events: [
      { type: 'ACCEPTED', at: t0, actor: 'api', attempt: 0, seq: 1 },
      { type: 'PROCESSING_STARTED', at: t0, actor: 'worker', attempt: 1, seq: 1, details: { leaseSeconds: 60, ok: true } },
      { type: 'COMPLETED', at: t1, actor: 'worker', attempt: 1, seq: 1 },
    ],
  };

  it('accepts a completed request with its timeline', () => {
    expect(RequestDetailSchema.safeParse(detail).success).toBe(true);
  });

  it('shares the status consistency rules with the summary', () => {
    expect(RequestDetailSchema.safeParse({ ...detail, status: 'FAILED', result: undefined }).success).toBe(false);
  });

  const invalid: Array<[string, unknown]> = [
    ['unknown event type', { ...detail, events: [{ type: 'EXPLODED', at: t0, actor: 'api', attempt: 0, seq: 1 }] }],
    ['unknown actor', { ...detail, events: [{ type: 'ACCEPTED', at: t0, actor: 'cron', attempt: 0, seq: 1 }] }],
    ['event seq below 1', { ...detail, events: [{ type: 'ACCEPTED', at: t0, actor: 'api', attempt: 0, seq: 0 }] }],
    ['nested event details', { ...detail, events: [{ type: 'ACCEPTED', at: t0, actor: 'api', attempt: 0, seq: 1, details: { a: { b: 1 } } }] }],
    ['unknown source', { ...detail, source: 'cli' }],
    ['unknown attribute', { ...detail, attributes: { color: 'red' } }],
    ['invalid tenant slug', { ...detail, tenantId: 'Sand Box' }],
    ['too many events', { ...detail, events: Array.from({ length: 201 }, () => detail.events[0]) }],
  ];
  it.each(invalid)('rejects %s', (_name, body) => {
    expect(RequestDetailSchema.safeParse(body).success).toBe(false);
  });
});

describe('list contracts', () => {
  it('applies list defaults', () => {
    expect(ListRequestsQuerySchema.parse({})).toEqual({ limit: 20, scope: 'mine' });
  });

  it('coerces limit from a query string', () => {
    expect(ListRequestsQuerySchema.parse({ limit: '50', scope: 'tenant', cursor: 'abc_DEF-123' })).toEqual({
      limit: 50,
      scope: 'tenant',
      cursor: 'abc_DEF-123',
    });
  });

  it.each([
    ['limit 0', { limit: '0' }],
    ['limit 101', { limit: '101' }],
    ['limit not a number', { limit: 'many' }],
    ['fractional limit', { limit: '2.5' }],
    ['unknown scope', { scope: 'all' }],
    ['cursor with unsafe characters', { cursor: 'a b/c' }],
    ['empty cursor', { cursor: '' }],
    ['cursor too long', { cursor: 'a'.repeat(513) }],
  ])('rejects %s', (_name, query) => {
    expect(ListRequestsQuerySchema.safeParse(query).success).toBe(false);
  });

  it('accepts limit boundaries', () => {
    expect(ListRequestsQuerySchema.safeParse({ limit: '1' }).success).toBe(true);
    expect(ListRequestsQuerySchema.safeParse({ limit: '100' }).success).toBe(true);
  });

  it('validates the page envelope', () => {
    expect(ListRequestsResponseSchema.safeParse({ items: [accepted, completed], nextCursor: 'abc' }).success).toBe(true);
    expect(ListRequestsResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(ListRequestsResponseSchema.safeParse({ items: [] }).success).toBe(false);
    expect(ListRequestsResponseSchema.safeParse({ items: [{ ...accepted, status: 'NOPE' }], nextCursor: null }).success).toBe(false);
  });

  it('validates path params and builds the canonical location', () => {
    expect(RequestIdParamsSchema.safeParse({ requestId }).success).toBe(true);
    expect(RequestIdParamsSchema.safeParse({ requestId: '123' }).success).toBe(false);
    expect(requestPath(requestId)).toBe(`/api/v1/requests/${requestId}`);
  });
});
