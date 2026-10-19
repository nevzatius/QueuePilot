import { describe, expect, it } from 'vitest';
import { CreateRequestBodySchema, CreateRequestResponseSchema } from '../src/index.js';

const valid = { type: 'roadside_assistance', title: 'Leaking pipe' } as const;

describe('CreateRequestBodySchema', () => {
  it('applies defaults for optional fields', () => {
    expect(CreateRequestBodySchema.parse(valid)).toEqual({
      type: 'roadside_assistance',
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
    const attributes = { safetyRisk: true, locationType: 'highway', preferredWindow: 'morning' };
    expect(CreateRequestBodySchema.parse({ ...valid, attributes }).attributes).toEqual(attributes);
  });

  const invalid: Array<[string, unknown]> = [
    ['missing type', { title: 'Leaking pipe' }],
    ['unknown type', { ...valid, type: 'plumbing' }],
    ['missing title', { type: 'roadside_assistance' }],
    ['title too short (2)', { ...valid, title: 'ab' }],
    ['title blank after trim', { ...valid, title: '     ' }],
    ['title too long (121)', { ...valid, title: 'x'.repeat(121) }],
    ['description too long (2001)', { ...valid, description: 'x'.repeat(2001) }],
    ['unknown priority', { ...valid, priority: 'critical' }],
    ['unknown type', { ...valid, type: 'maintenance' }],
    ['safetyRisk as string', { ...valid, attributes: { safetyRisk: 'high' } }],
    ['unknown locationType', { ...valid, attributes: { locationType: 'indoor' } }],
    ['nested object attribute', { ...valid, attributes: { vehicle: { make: 'x' } } }],
    ['array attribute', { ...valid, attributes: { tags: ['a'] } }],
    ['null attribute', { ...valid, attributes: { note: null } }],
    ['over-long string attribute', { ...valid, attributes: { note: 'x'.repeat(201) } }],
    ['non-finite number attribute', { ...valid, attributes: { n: Infinity } }],
    ['invalid attribute key', { ...valid, attributes: { 'bad key': 1 } }],
    ['attribute key too long', { ...valid, attributes: { ['k'.repeat(33)]: 1 } }],
    ['too many attributes (21)', { ...valid, attributes: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) }],
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

  it('accepts bounded extra primitive attributes up to the limit', () => {
    const extra = { vehiclePlate: 'AB123', passengers: 3, towRequired: false, note: 'x'.repeat(200) };
    expect(CreateRequestBodySchema.parse({ ...valid, attributes: extra }).attributes).toEqual(extra);
    const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    expect(CreateRequestBodySchema.safeParse({ ...valid, attributes: twenty }).success).toBe(true);
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
