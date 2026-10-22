import { Redis } from 'ioredis';
import type { Clock } from '@queuepilot/domain';
import { REDIS_CONNECT_TIMEOUT_DEFAULT_MS } from '../config.js';

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

/** Per command, after the connection is ready. Measured about 2 ms on Upstash free (ADR-019 spike). */
export const REDIS_COMMAND_TIMEOUT_MS = 100;

export function createRedisConnection(url: string, connectTimeoutMs = REDIS_CONNECT_TIMEOUT_DEFAULT_MS): RedisConnection {
  let client: Redis;
  try {
    client = new Redis(url, {
      lazyConnect: true, commandTimeout: REDIS_COMMAND_TIMEOUT_MS, connectTimeout: connectTimeoutMs,
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
  constructor(private readonly client: RedisConnection | undefined, private readonly clock: Clock,
    private readonly connectTimeoutMs = REDIS_CONNECT_TIMEOUT_DEFAULT_MS) {}

  /**
   * Starts connecting in the background so the first request does not pay the cold connect (about 400 ms on
   * Upstash free). Never throws and never records a failure: a failed warm-up changes nothing, and the next
   * request connects (or fails closed) on its own deadline exactly as without a warm-up.
   */
  async warm(): Promise<void> {
    const client = this.client;
    if (!client || this.closed || client.status === 'ready') return;
    try { await this.connect(client); } catch { /* The connection's own connectTimeout bounds this; requests re-try. */ }
  }

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
      if (client.status === 'ready') await deadline(() => client.quit(), REDIS_COMMAND_TIMEOUT_MS);
    } catch { /* Shutdown is bounded even on a broken socket. */ }
    finally { client.disconnect(); }
  }
  private async execute<T>(command: (client: RedisConnection) => Promise<T>): Promise<T> {
    const client = this.client;
    if (!client || this.closed || this.clock.now() < this.openUntil || this.probing) throw new RedisUnavailable();
    const probe = this.failures >= 5;
    if (probe) this.probing = true;
    try {
      // Two budgets, so a cold connect (about 400 ms) does not eat the command's 100 ms; a command still gets
      // the full REDIS_COMMAND_TIMEOUT_MS. A request that cannot connect fails closed after connectTimeoutMs.
      if (client.status !== 'ready') await deadline(() => this.connect(client), this.connectTimeoutMs);
      if (this.closed) throw new RedisUnavailable();
      const value = await deadline(() => command(client), REDIS_COMMAND_TIMEOUT_MS);
      this.failures = 0;
      this.openUntil = 0;
      return value;
    } catch {
      this.failures++;
      if (this.failures >= 5) this.openUntil = this.clock.now() + 30_000;
      // Do not resend timed-out commands: their outcome may be unknown.
      client.disconnect();
      this.connecting = undefined;
      throw new RedisUnavailable();
    } finally { if (probe) this.probing = false; }
  }
  /** One connect attempt at a time; callers (requests, the warm-up) share it. */
  private connect(client: RedisConnection): Promise<unknown> {
    if (!this.connecting) {
      const connecting = client.connect();
      this.connecting = connecting;
      const clear = () => { if (this.connecting === connecting) this.connecting = undefined; };
      void connecting.then(clear, clear);
    }
    return this.connecting;
  }
}

async function deadline<T>(operation: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RedisUnavailable()), ms);
    })]);
  } finally { clearTimeout(timer); }
}
