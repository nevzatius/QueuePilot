import type { RedisConnection } from '@queuepilot/core';
import { BURST_SCRIPT, QUOTA_SCRIPT, QUOTA_RELEASE_SCRIPT } from '@queuepilot/core';

export class FakeClock {
  value = Date.UTC(2026, 9, 20, 12, 0, 10);
  now = () => this.value;
  advance(ms: number) { this.value += ms; }
}

/** Synchronous mutations model Redis script serialization; the real suite checks Lua itself. */
export class RedisDouble implements RedisConnection {
  status = 'wait';
  mode: 'healthy' | 'fail' | 'timeout' = 'healthy';
  connects = 0;
  commands = 0;
  quits = 0;
  disconnects = 0;
  readonly entries = new Map<string, { value: string; until: number }>();
  constructor(readonly clock: FakeClock) {}
  async connect() {
    this.connects++;
    this.status = 'ready';
  }
  private check(): Promise<never> | undefined {
    this.commands++;
    if (this.mode === 'timeout') return new Promise<never>(() => {});
    if (this.mode === 'fail' || this.status !== 'ready') throw new Error('redis://user:secret-password@private-host:6379');
  }
  private read(key: string): string | null {
    const entry = this.entries.get(key);
    if (!entry || this.clock.now() >= entry.until) { this.entries.delete(key); return null; }
    return entry.value;
  }
  async get(key: string) {
    const stalled = this.check();
    if (stalled) return stalled;
    return this.read(key);
  }
  async set(key: string, value: string, _mode: 'PX', ttl: number) {
    const stalled = this.check();
    if (stalled) return stalled;
    this.entries.set(key, { value, until: this.clock.now() + ttl });
    return 'OK';
  }
  async eval(script: string, numberOfKeys: number, ...input: string[]): Promise<unknown> {
    const stalled = this.check();
    if (stalled) return stalled;
    const keys = input.slice(0, numberOfKeys);
    const args = input.slice(numberOfKeys);
    const first = keys[0]!;
    const second = keys[1]!;
    const receipt = keys[2]!;
    if (script === BURST_SCRIPT) {
      const value = Number(this.read(first) ?? 0) + 1;
      const until = this.entries.get(first)?.until ?? this.clock.now() + Number(args[0]);
      this.entries.set(first, { value: String(value), until });
      return value;
    }
    if (script === QUOTA_SCRIPT) {
      if (this.read(receipt)) return 1;
      const user = Number(this.read(first) ?? 0);
      const tenant = Number(this.read(second) ?? 0);
      if (user >= Number(args[0]) || tenant >= Number(args[1])) return 0;
      const until = this.clock.now() + Number(args[2]);
      this.entries.set(first, { value: String(user + 1), until });
      this.entries.set(second, { value: String(tenant + 1), until });
      this.entries.set(receipt, { value: '1', until });
      return 1;
    }
    if (script === QUOTA_RELEASE_SCRIPT) {
      if (!this.read(receipt)) return 0;
      this.entries.delete(receipt);
      for (const key of [first, second]) {
        const value = Number(this.read(key) ?? 0);
        if (value > 0) this.entries.get(key)!.value = String(value - 1);
      }
      return 1;
    }
    throw new Error('Unexpected script');
  }
  async quit() { this.quits++; this.status = 'end'; }
  disconnect() { this.disconnects++; this.status = 'end'; }
}
