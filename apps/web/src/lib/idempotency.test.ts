import { describe, expect, it } from 'vitest';
import { IdempotencyKeySchema } from '@queuepilot/contracts';
import { createKeyManager } from './idempotency';

function counter() {
  let n = 0;
  return () => `key-${String(++n).padStart(8, '0')}`;
}

describe('createKeyManager', () => {
  it('reuses the key while the payload is unchanged', () => {
    const keys = createKeyManager(counter());
    const payload = { title: 'A request' };
    expect(keys.keyFor(payload)).toBe(keys.keyFor({ ...payload }));
  });

  it('issues a new key when the payload changes', () => {
    const keys = createKeyManager(counter());
    expect(keys.keyFor({ title: 'one' })).not.toBe(keys.keyFor({ title: 'two' }));
  });

  it('issues a new key after reset, even for the same payload', () => {
    const keys = createKeyManager(counter());
    const first = keys.keyFor({ title: 'one' });
    keys.reset();
    expect(keys.keyFor({ title: 'one' })).not.toBe(first);
  });

  it('generates keys the API contract accepts', () => {
    expect(IdempotencyKeySchema.safeParse(createKeyManager().keyFor({})).success).toBe(true);
  });
});
