import { Redis } from 'ioredis';
import type { Clock } from '@queuepilot/domain';

/** Only this boundary knows about ioredis. Never propagate dependency errors or URLs. */
export interface RedisConnection {
  readonly status: string;
  connect(): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttl: number): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}
export interface RedisAccess {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}
export interface RedisLog { warn(fields: { code: string }, message: string): void }
export class RedisUnavailable extends Error {
  constructor() { super('Redis unavailable'); }
}

export function createRedisConnection(url: string): RedisConnection {
  let client: Redis;
  try {
    client = new Redis(url, {
      lazyConnect: true, commandTimeout: 100, connectTimeout: 100,
      maxRetriesPerRequest: 0, retryStrategy: () => null,
      enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
    });
  } catch { throw new RedisUnavailable(); }
  // All failures are handled by the awaited operation, without logging raw errors.
  client.on('error', () => {});
  return client;
}

/** No background reconnect loop. One half-open request probes after the cooldown. */
export class ManagedRedis implements RedisAccess {
  private failures = 0;
  private openUntil = 0;
  private probing = false;
  private closed = false;
  private connecting: Promise<unknown> | undefined;
  constructor(private readonly client: RedisConnection | undefined, private readonly clock: Clock) {}

  eval(script: string, keys: string[], args: string[]) {
    return this.execute((client) => client.eval(script, keys.length, ...keys, ...args));
  }
  get(key: string) { return this.execute((client) => client.get(key)); }
  async set(key: string, value: string, ttlMs: number) {
    await this.execute((client) => client.set(key, value, 'PX', Math.max(1, Math.min(5000, Math.floor(ttlMs)))));
  }
  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    if (!client) return;
    try {
      if (client.status === 'ready') await deadline(() => client.quit());
    } catch { /* Shutdown is bounded even on a broken socket. */ }
    finally { client.disconnect(); }
  }
  private async execute<T>(command: (client: RedisConnection) => Promise<T>): Promise<T> {
    const client = this.client;
    if (!client || this.closed || this.clock.now() < this.openUntil || this.probing) throw new RedisUnavailable();
    const probe = this.failures >= 5;
    if (probe) this.probing = true;
    let abandoned = false;
    try {
      const value = await deadline(async () => {
        if (client.status !== 'ready') {
          if (!this.connecting) {
            const connecting = client.connect();
            this.connecting = connecting;
            const clear = () => { if (this.connecting === connecting) this.connecting = undefined; };
            void connecting.then(clear, clear);
          }
          await this.connecting;
        }
        if (abandoned || this.closed) throw new RedisUnavailable();
        return command(client);
      });
      this.failures = 0;
      this.openUntil = 0;
      return value;
    } catch {
      abandoned = true;
      this.failures++;
      if (this.failures >= 5) this.openUntil = this.clock.now() + 30_000;
      // Do not resend timed-out commands: their outcome may be unknown.
      client.disconnect();
      this.connecting = undefined;
      throw new RedisUnavailable();
    } finally { if (probe) this.probing = false; }
  }
}

async function deadline<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RedisUnavailable()), 100);
    })]);
  } finally { clearTimeout(timer); }
}
