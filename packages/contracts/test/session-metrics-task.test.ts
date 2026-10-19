import { describe, expect, it } from 'vitest';
import {
  BootstrapRequestSchema,
  BootstrapResponseSchema,
  MeResponseSchema,
  MetricsResponseSchema,
  TaskPayloadSchema,
} from '../src/index.js';

const membership = { tenantId: 'sandbox', tenantName: 'Sandbox', tenantStatus: 'active', role: 'member', status: 'active' };

describe('session contracts', () => {
  it('allows /me without a membership (onboarding required)', () => {
    expect(MeResponseSchema.safeParse({ uid: 'u1', email: 'a@example.com', membership: null }).success).toBe(true);
    expect(MeResponseSchema.safeParse({ uid: 'u1', email: null, membership }).success).toBe(true);
  });

  it.each([
    ['missing uid', { email: null, membership: null }],
    ['membership omitted instead of null', { uid: 'u1', email: null }],
    ['unknown role', { uid: 'u1', email: null, membership: { ...membership, role: 'owner' } }],
    ['unknown membership status', { uid: 'u1', email: null, membership: { ...membership, status: 'banned' } }],
  ])('rejects /me with %s', (_name, body) => {
    expect(MeResponseSchema.safeParse(body).success).toBe(false);
  });

  it('accepts an absent or empty bootstrap body', () => {
    expect(BootstrapRequestSchema.safeParse(undefined).success).toBe(true);
    expect(BootstrapRequestSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    ['role escalation', { role: 'admin' }],
    ['tenant choice', { tenantId: 'loadtest' }],
    ['null', null],
    ['array', []],
  ])('rejects a bootstrap body with %s', (_name, body) => {
    expect(BootstrapRequestSchema.safeParse(body).success).toBe(false);
  });

  it('validates the bootstrap response', () => {
    expect(BootstrapResponseSchema.safeParse({ created: true, membership }).success).toBe(true);
    expect(BootstrapResponseSchema.safeParse({ membership }).success).toBe(false);
  });
});

describe('MetricsResponseSchema', () => {
  const metrics = {
    tenantId: 'sandbox',
    generatedAt: '2026-10-20T09:00:00.000Z',
    source: 'redis',
    counts: { ACCEPTED: 3, PROCESSING: 1, COMPLETED: 40, FAILED: 2 },
    stuck: 0,
  };

  it('accepts a valid snapshot', () => {
    expect(MetricsResponseSchema.safeParse(metrics).success).toBe(true);
  });

  it.each([
    ['negative count', { ...metrics, counts: { ...metrics.counts, FAILED: -1 } }],
    ['fractional count', { ...metrics, counts: { ...metrics.counts, ACCEPTED: 1.5 } }],
    ['derived status as a count key only (missing PROCESSING)', { ...metrics, counts: { ACCEPTED: 0, COMPLETED: 0, FAILED: 0 } }],
    ['unknown source', { ...metrics, source: 'cdn' }],
    ['negative stuck', { ...metrics, stuck: -1 }],
    ['bad timestamp', { ...metrics, generatedAt: 'yesterday' }],
  ])('rejects %s', (_name, body) => {
    expect(MetricsResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('TaskPayloadSchema', () => {
  const payload = {
    requestId: '3f2b8c1e-6a4d-4f0b-9c1d-2e7a5b8c9d01',
    tenantId: 'sandbox',
    seq: 1,
    correlationId: 'corr-1234',
  };

  it('accepts the documented payload', () => {
    expect(TaskPayloadSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    ['seq 0', { ...payload, seq: 0 }],
    ['fractional seq', { ...payload, seq: 1.5 }],
    ['string seq', { ...payload, seq: '1' }],
    ['missing correlationId', { ...payload, correlationId: undefined }],
    ['bad requestId', { ...payload, requestId: 'r-1' }],
    ['extra field', { ...payload, attempts: 2 }],
    ['not an object', 'payload'],
  ])('rejects %s', (_name, body) => {
    expect(TaskPayloadSchema.safeParse(body).success).toBe(false);
  });
});
