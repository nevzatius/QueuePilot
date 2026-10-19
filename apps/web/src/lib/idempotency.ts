/**
 * Idempotency-Key management for the submit form (ARCHITECTURE §9).
 * The same key is reused while the payload is unchanged, so a retry after a timeout or 5xx cannot
 * create a second request. A changed payload gets a fresh key, because reusing a key with a different
 * payload is answered with `409 IDEMPOTENCY_KEY_REUSED`. Call `reset()` once a submission succeeded.
 */
export interface KeyManager {
  keyFor(payload: unknown): string;
  reset(): void;
}

export function createKeyManager(generate: () => string = () => crypto.randomUUID()): KeyManager {
  let current: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(payload) {
      const fingerprint = JSON.stringify(payload);
      if (!current || current.fingerprint !== fingerprint) current = { fingerprint, key: generate() };
      return current.key;
    },
    reset() {
      current = null;
    },
  };
}
