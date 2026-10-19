import { createHash } from 'node:crypto';
import type { CreateRequestBody } from '@queuepilot/contracts';

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no whitespace, `undefined` object
 * members omitted. Only JSON data is accepted; anything else (NaN, Infinity, bigint, functions, class
 * instances, `undefined` array items) throws, because it has no stable encoding.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value); // -0 serialises as 0
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item: unknown) => {
        if (item === undefined) throw new TypeError('canonicalJson: undefined array item');
        return canonicalJson(item);
      })
      .join(',')}]`;
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const members = Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Idempotency payload fingerprint (ARCHITECTURE §9): sha256 of the canonical **validated** body, i.e.
 * the output of `CreateRequestBodySchema`. Defaults are applied and strings trimmed before hashing, so
 * an omitted default and an explicit default produce the same fingerprint.
 */
export function payloadFingerprint(body: CreateRequestBody): string {
  return sha256Hex(canonicalJson(body));
}

/**
 * Document ID of `idempotencyKeys/{h}` for the `(tenant, uid, key)` scope. The tuple is encoded as a
 * canonical JSON array rather than joined with `:`, because uids and keys may contain `:` and a plain
 * join would let two scopes collide.
 */
export function idempotencyDocId(tenantId: string, uid: string, key: string): string {
  return sha256Hex(canonicalJson([tenantId, uid, key]));
}

/** Deterministic unsigned 32-bit hash: the first four bytes of sha256. */
export function stableHash32(input: string): number {
  return createHash('sha256').update(input, 'utf8').digest().readUInt32BE(0);
}
