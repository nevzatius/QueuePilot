import { describe, expect, it } from 'vitest';
import { CreateRequestBodySchema, CreateRequestResponseSchema } from '../src/index.js';

const valid = { type: 'maintenance', title: 'Leaking pipe' } as const;

describe('CreateRequestBodySchema', () => {
  it('applies defaults for optional fields', () => {
    expect(CreateRequestBodySchema.parse(valid)).toEqual({
      type: 'maintenance',
      title: 'Leaking pipe',
      description: '',
      priority: 'normal',
      attributes: {},
    });
  });

  it('hashes omitted and explicit defaults identically (canonical output)', () => {
    const explicit = { ...valid, description: '', priority: 'normal', attributes: {} };
    expect(CreateRequestBodySchema.parse(explicit)).toEqual(CreateRequestBodySchema.parse(valid));
  });

  it('trims title and description', () => {
    const out = CreateRequestBodySchema.parse({ ...valid, title: '  Leaking pipe  ', description: '\n text \n' });
    expect(out.title).toBe('Leaking pipe');
    expect(out.description).toBe('text');
  });

  it('accepts all triage attributes', () => {
    const attributes = { safetyRisk: 'high', locationType: 'outdoor', preferredWindow: 'morning' };
    expect(CreateRequestBodySchema.parse({ ...valid, attributes }).attributes).toEqual(attributes);
  });

  const invalid: Array<[string, unknown]> = [
    ['missing type', { title: 'Leaking pipe' }],
    ['unknown type', { ...valid, type: 'plumbing' }],
    ['missing title', { type: 'maintenance' }],
    ['title too short (2)', { ...valid, title: 'ab' }],
    ['title blank after trim', { ...valid, title: '     ' }],
    ['title too long (121)', { ...valid, title: 'x'.repeat(121) }],
    ['description too long (2001)', { ...valid, description: 'x'.repeat(2001) }],
    ['unknown priority', { ...valid, priority: 'critical' }],
    ['unknown attribute value', { ...valid, attributes: { safetyRisk: 'extreme' } }],
    ['unknown attribute key', { ...valid, attributes: { color: 'red' } }],
    ['client-supplied tenantId', { ...valid, tenantId: 'sandbox' }],
    ['client-supplied createdBy', { ...valid, createdBy: 'uid-1' }],
    ['client-supplied status', { ...valid, status: 'COMPLETED' }],
    ['non-string title', { ...valid, title: 123 }],
    ['null body', null],
    ['array body', []],
  ];
  it.each(invalid)('rejects %s', (_name, body) => {
    expect(CreateRequestBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts boundary lengths', () => {
    expect(CreateRequestBodySchema.safeParse({ ...valid, title: 'abc' }).success).toBe(true);
    expect(CreateRequestBodySchema.safeParse({ ...valid, title: 'x'.repeat(120) }).success).toBe(true);
    expect(CreateRequestBodySchema.safeParse({ ...valid, description: 'x'.repeat(2000) }).success).toBe(true);
  });

  it('reports the failing path', () => {
    const r = CreateRequestBodySchema.safeParse({ ...valid, title: 'ab' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['title']);
  });
});

describe('CreateRequestResponseSchema', () => {
  const requestId = '3f2b8c1e-6a4d-4f0b-9c1d-2e7a5b8c9d01';
  it('accepts requestId and location', () => {
    expect(CreateRequestResponseSchema.safeParse({ requestId, location: `/api/v1/requests/${requestId}` }).success).toBe(
      true,
    );
  });
  it('rejects a non-v4 or malformed requestId', () => {
    expect(CreateRequestResponseSchema.safeParse({ requestId: 'abc', location: '/x' }).success).toBe(false);
    // v1 UUID (time-based) must be rejected: ARCHITECTURE §13 forbids time-ordered IDs.
    expect(
      CreateRequestResponseSchema.safeParse({ requestId: 'c232ab00-9414-11ec-b3c8-9f6bdeced846', location: '/x' }).success,
    ).toBe(false);
  });
});
