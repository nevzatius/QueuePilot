import { CreateRequestBodySchema } from '@queuepilot/contracts';
import { describe, expect, it } from 'vitest';
import { canonicalJson, idempotencyDocId, payloadFingerprint, sha256Hex, stableHash32 } from '../src/index.js';

describe('canonicalJson', () => {
  const rows: Array<[string, unknown, string]> = [
    ['null', null, 'null'],
    ['booleans', [true, false], '[true,false]'],
    ['negative zero', -0, '0'],
    ['numbers', [1, 1.5, -2e-7], '[1,1.5,-2e-7]'],
    ['string escaping', 'a"b\\c\n', '"a\\"b\\\\c\\n"'],
    ['sorted keys', { b: 1, a: 2, C: 3 }, '{"C":3,"a":2,"b":1}'],
    ['nested objects are sorted', { z: { y: 1, x: [{ b: 1, a: 0 }] } }, '{"z":{"x":[{"a":0,"b":1}],"y":1}}'],
    ['undefined members are omitted', { a: undefined, b: 1 }, '{"b":1}'],
    ['array order is preserved', [3, 1, 2], '[3,1,2]'],
    ['null-prototype objects', Object.assign(Object.create(null) as object, { k: 'v' }), '{"k":"v"}'],
  ];

  it.each(rows)('%s', (_name, value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it('rejects values without a stable encoding', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1n, () => 1, new Date(0), new Map(), [undefined], Symbol('s')]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
    }
  });

  it('rejects sparse arrays, so [] and Array(1) never share an encoding', () => {
    expect(canonicalJson([])).toBe('[]');
    // eslint-disable-next-line no-sparse-arrays
    const sparse: unknown[] = [Array(1), Array(3), [1, , 2], { a: [, 1] }, [[], Array(1)]];
    for (const bad of sparse) expect(() => canonicalJson(bad)).toThrow('canonicalJson: sparse array');
    // An explicitly filled array is dense and encodes normally.
    expect(canonicalJson(Array.from({ length: 2 }, () => null))).toBe('[null,null]');
  });
});

describe('payloadFingerprint (ARCHITECTURE §9)', () => {
  const parse = (input: unknown) => CreateRequestBodySchema.parse(input);
  const base = { type: 'roadside_assistance', title: 'Flat tyre on A1', attributes: { safetyRisk: true, locationType: 'highway' } };

  it('is independent of key order and of omitted versus explicit defaults', () => {
    const a = payloadFingerprint(parse(base));
    const reordered = payloadFingerprint(
      parse({ attributes: { locationType: 'highway', safetyRisk: true }, title: 'Flat tyre on A1', type: 'roadside_assistance' }),
    );
    const explicit = payloadFingerprint(parse({ ...base, description: '', priority: 'normal' }));
    const padded = payloadFingerprint(parse({ ...base, title: '  Flat tyre on A1  ' }));
    expect(new Set([a, reordered, explicit, padded]).size).toBe(1);
  });

  it('changes with any semantic difference', () => {
    const a = payloadFingerprint(parse(base));
    const variants = [
      { ...base, priority: 'high' },
      { ...base, title: 'Flat tyre on A2' },
      { ...base, attributes: { ...base.attributes, safetyRisk: false } },
      { ...base, attributes: { ...base.attributes, plate: 'AB123' } },
      { ...base, type: 'general' },
    ];
    for (const v of variants) expect(payloadFingerprint(parse(v))).not.toBe(a);
  });

  it('is a stable sha256 hex digest (golden value)', () => {
    const fp = payloadFingerprint(parse(base));
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fp).toBe(
      sha256Hex(
        '{"attributes":{"locationType":"highway","safetyRisk":true},"description":"","priority":"normal","title":"Flat tyre on A1","type":"roadside_assistance"}',
      ),
    );
  });
});

describe('idempotencyDocId', () => {
  it('scopes keys by tenant and uid without ambiguity on ":"', () => {
    const id = idempotencyDocId('sandbox', 'uid-1', 'key-12345678');
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyDocId('sandbox', 'uid-1', 'key-12345678')).toBe(id);
    expect(idempotencyDocId('sandbox', 'uid-2', 'key-12345678')).not.toBe(id);
    expect(idempotencyDocId('loadtest', 'uid-1', 'key-12345678')).not.toBe(id);
    expect(idempotencyDocId('sandbox', 'a:b', 'c')).not.toBe(idempotencyDocId('sandbox', 'a', 'b:c'));
  });
});

describe('stableHash32', () => {
  it('is a deterministic unsigned 32-bit value', () => {
    const h = stableHash32('x');
    expect(h).toBe(stableHash32('x'));
    expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
    expect(stableHash32('y')).not.toBe(h);
  });
});
