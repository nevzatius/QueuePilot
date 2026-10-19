import { describe, expect, it } from 'vitest';
import { HEADERS, IdempotencyHeadersSchema, IdempotencyKeySchema } from '../src/index.js';

describe('IdempotencyKeySchema', () => {
  const accepted: Array<[string, string]> = [
    ['minimum length (8)', 'abcd1234'],
    ['maximum length (128)', 'k'.repeat(128)],
    ['uuid', '3f2b8c1e-6a4d-4f0b-9c1d-2e7a5b8c9d01'],
    ['punctuation', 'a.b_c:d~e-f+g=h'],
  ];
  it.each(accepted)('accepts %s', (_name, key) => {
    expect(IdempotencyKeySchema.safeParse(key).success).toBe(true);
  });

  const rejected: Array<[string, unknown]> = [
    ['too short (7)', 'abcd123'],
    ['too long (129)', 'k'.repeat(129)],
    ['empty', ''],
    ['embedded space', 'abcd 1234'],
    ['leading space', ' abcd1234'],
    ['tab', 'abcd\t1234'],
    ['newline', 'abcd\n1234'],
    ['non-ASCII', 'abcd123é'],
    ['not a string', 12345678],
    ['undefined', undefined],
  ];
  it.each(rejected)('rejects %s', (_name, key) => {
    expect(IdempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});

describe('IdempotencyHeadersSchema', () => {
  it('reads the lower-case header name Fastify exposes', () => {
    expect(HEADERS.idempotencyKey).toBe('idempotency-key');
    expect(IdempotencyHeadersSchema.parse({ 'idempotency-key': 'abcd1234', host: 'x' })).toEqual({
      'idempotency-key': 'abcd1234',
    });
  });
  it('rejects a missing header', () => {
    expect(IdempotencyHeadersSchema.safeParse({}).success).toBe(false);
  });
  it('does not match the mixed-case spelling (headers are normalised before validation)', () => {
    expect(IdempotencyHeadersSchema.safeParse({ 'Idempotency-Key': 'abcd1234' }).success).toBe(false);
  });
});
