import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { describe, expect, it } from 'vitest';

// Fail before IO if someone runs the suite against anything but local emulators.
function localHost(name: string): string {
  const value = process.env[name];
  if (!value || !/^(127\.0\.0\.1|localhost):\d+$/.test(value)) {
    throw new Error(`${name} must identify a local emulator`);
  }
  return value;
}

describe('local integration infrastructure', () => {
  it('writes, reads and deletes a Firestore emulator document', async () => {
    const host = localHost('FIRESTORE_EMULATOR_HOST');
    const url = `http://${host}/v1/projects/demo-queuepilot/databases/(default)/documents/foundation/${randomUUID()}`;
    // firebase.json loads the deny-all rules (as in production); the emulator's owner token bypasses them like the Admin SDK does.
    const owner = { authorization: 'Bearer owner' };
    // Without the owner token the same document is denied, for reads and writes: this is what proves the rules are loaded and deny-all
    // (the owner calls below would succeed with or without rules).
    const denied = await fetch(url);
    expect(denied.status).toBe(403);
    const deniedWrite = await fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: { check: { stringValue: 'anonymous' } } }) });
    expect(deniedWrite.status).toBe(403);
    try {
      const write = await fetch(url, {
        method: 'PATCH',
        headers: { ...owner, 'content-type': 'application/json' },
        body: JSON.stringify({ fields: { check: { stringValue: 'foundation' } } }),
      });
      expect(write.status).toBe(200);
      const read = await fetch(url, { headers: owner });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ fields: { check: { stringValue: 'foundation' } } });
    } finally {
      const deleted = await fetch(url, { method: 'DELETE', headers: owner });
      expect(deleted.status).toBe(200);
    }
  });

  it('creates and deletes an anonymous user in the Auth emulator', async () => {
    const host = localHost('FIREBASE_AUTH_EMULATOR_HOST');
    const base = `http://${host}/identitytoolkit.googleapis.com/v1/accounts`;
    const created = await fetch(`${base}:signUp?key=demo-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    expect(created.status).toBe(200);
    const user = await created.json() as { idToken: string; localId: string };
    expect(user.localId).toBeTruthy();
    const deleted = await fetch(`${base}:delete?key=demo-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: user.idToken }),
    });
    expect(deleted.status).toBe(200);
  });

  it('pings Redis and round-trips an expiring isolated key', async () => {
    const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
    const parsed = new URL(url);
    if (parsed.protocol !== 'redis:' || !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      throw new Error('REDIS_URL must identify local Redis');
    }
    const client = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } });
    client.on('error', () => { /* Connection errors reject the awaited operation. */ });
    const key = `foundation:${randomUUID()}`;
    try {
      await client.connect();
      expect(await client.ping()).toBe('PONG');
      await client.set(key, 'ready', { EX: 30 });
      expect(await client.get(key)).toBe('ready');
      expect(await client.ttl(key)).toBeGreaterThan(0);
    } finally {
      if (client.isReady) {
        await client.del(key);
        await client.quit();
      } else if (client.isOpen) {
        client.destroy();
      }
    }
  });
});
