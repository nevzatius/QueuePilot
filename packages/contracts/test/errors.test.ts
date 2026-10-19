import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG,
  ERROR_CODES,
  ErrorCodeSchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  createProblem,
  problemTypeUri,
  type ErrorCode,
} from '../src/index.js';

describe('error catalog', () => {
  it('exposes every architecture-mandated code with the documented status', () => {
    const expected: Array<[ErrorCode, number]> = [
      ['ONBOARDING_REQUIRED', 403],
      ['IDEMPOTENCY_KEY_REUSED', 409],
      ['QUOTA_UNAVAILABLE', 503],
      ['OVERLOADED', 503],
      ['BACKLOG_FULL', 503],
      ['NOT_FOUND', 404],
    ];
    for (const [code, status] of expected) expect(ERROR_CATALOG[code].status).toBe(status);
  });

  it('only uses client/server error statuses', () => {
    for (const code of ERROR_CODES) {
      const { status } = ERROR_CATALOG[code];
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('derives unique, URN-shaped problem types', () => {
    const uris = ERROR_CODES.map(problemTypeUri);
    expect(new Set(uris).size).toBe(ERROR_CODES.length);
    expect(problemTypeUri('IDEMPOTENCY_KEY_REUSED')).toBe('urn:queuepilot:problem:idempotency-key-reused');
  });

  it('validates codes', () => {
    expect(ErrorCodeSchema.safeParse('OVERLOADED').success).toBe(true);
    expect(ErrorCodeSchema.safeParse('overloaded').success).toBe(false);
    expect(ErrorCodeSchema.safeParse('TEAPOT').success).toBe(false);
  });
});

describe('ProblemDetailsSchema (RFC 9457)', () => {
  it('uses the RFC media type', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
  });

  it('round-trips every code produced by createProblem', () => {
    for (const code of ERROR_CODES) {
      const p = createProblem({ code, correlationId: 'corr-1234' });
      expect(ProblemDetailsSchema.parse(p)).toEqual(p);
      expect(p.status).toBe(ERROR_CATALOG[code].status);
    }
  });

  it('carries validation issues and retry hints', () => {
    const p = createProblem({
      code: 'VALIDATION_FAILED',
      correlationId: 'corr-1234',
      detail: 'Body is invalid',
      instance: '/api/v1/requests',
      errors: [{ pointer: '/title', message: 'Too short' }],
    });
    expect(ProblemDetailsSchema.parse(p).errors).toHaveLength(1);

    const busy = createProblem({ code: 'OVERLOADED', correlationId: 'corr-1234', retryAfterSeconds: 2 });
    expect(busy.retryAfterSeconds).toBe(2);
  });

  it('omits optional members that were not supplied', () => {
    const p = createProblem({ code: 'NOT_FOUND', correlationId: 'corr-1234' });
    expect(Object.keys(p).sort()).toEqual(['code', 'correlationId', 'status', 'title', 'type']);
  });

  const base = createProblem({ code: 'NOT_FOUND', correlationId: 'corr-1234' });
  const invalid: Array<[string, unknown]> = [
    ['status disagrees with code', { ...base, status: 500 }],
    ['status below 400', { ...base, status: 200 }],
    ['unknown code', { ...base, code: 'TEAPOT' }],
    ['missing correlationId', { ...base, correlationId: undefined }],
    ['unsafe correlationId', { ...base, correlationId: 'a b\n' }],
    ['missing type', { ...base, type: undefined }],
    ['non-positive retryAfterSeconds', { ...base, retryAfterSeconds: 0 }],
    ['too many validation issues', { ...base, errors: Array.from({ length: 51 }, () => ({ pointer: '/x', message: 'm' })) }],
  ];
  it.each(invalid)('rejects %s', (_name, body) => {
    expect(ProblemDetailsSchema.safeParse(body).success).toBe(false);
  });
});
