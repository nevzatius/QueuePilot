import { afterEach, describe, expect, it, vi } from 'vitest';

const wiring = vi.hoisted(() => ({ connectionArgs: [] as unknown[][], warms: 0, managedArgs: [] as unknown[][] }));

vi.mock('@queuepilot/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@queuepilot/core')>();
  class RecordingRedis extends core.ManagedRedis {
    constructor(...args: ConstructorParameters<typeof core.ManagedRedis>) { super(...args); wiring.managedArgs.push(args.slice(2)); }
    override async warm() { wiring.warms++; }
  }
  return {
    ...core,
    ManagedRedis: RecordingRedis,
    createRedisConnection: (...args: unknown[]) => { wiring.connectionArgs.push(args); return undefined as never; },
  };
});

afterEach(() => { vi.unstubAllEnvs(); wiring.connectionArgs.length = 0; wiring.managedArgs.length = 0; wiring.warms = 0; });

describe('API runtime wiring of the Redis connection (B9-4)', () => {
  it('passes the configured connect timeout to the connection and to ManagedRedis, and starts the pre-warm', async () => {
    vi.stubEnv('QP_ENV', 'test');
    vi.stubEnv('GCLOUD_PROJECT', 'demo-queuepilot');
    vi.stubEnv('QP_REDIS_CONNECT_TIMEOUT_MS', '777');
    const { createRuntime } = await import('../src/runtime.js');
    const { app } = createRuntime();
    expect(wiring.connectionArgs).toHaveLength(1);
    expect(wiring.connectionArgs[0]?.[1]).toBe(777);
    expect(wiring.managedArgs).toEqual([[777]]);
    expect(wiring.warms).toBe(1);
    await app.close();
  });
  it('does not connect or warm into a client when Redis is disabled by configuration', async () => {
    vi.stubEnv('QP_ENV', 'test');
    vi.stubEnv('GCLOUD_PROJECT', 'demo-queuepilot');
    vi.stubEnv('QP_REDIS_ENABLED', 'false');
    const { createRuntime } = await import('../src/runtime.js');
    const { app } = createRuntime();
    expect(wiring.connectionArgs).toHaveLength(0);
    await app.close();
  });
});
