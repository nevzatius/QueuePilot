import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CloudTasksQueue, createLogger, loadConfig, LocalDispatchQueue } from '@queuepilot/core';
import type { CloudQueueConfig, TasksClient } from '@queuepilot/core';

const payload = () => ({ requestId: randomUUID(), tenantId: 'test-queue', seq: 1, correlationId: randomUUID() });
const signal = () => new AbortController().signal;
const config: CloudQueueConfig = { project: 'qp-test-project', region: 'europe-west1', queue: 'qp-process',
  workerUrl: 'https://worker.example.test', audience: 'https://worker.example.test', deadlineSeconds: 30,
  serviceAccount: 'qp-tasks-invoker-sa@qp-test-project.iam.gserviceaccount.com' };
const silentLog = () => createLogger({ write: () => {} });

describe('CloudTasksQueue (injected client, no network)', () => {
  it('uses named JSON tasks, deadline, OIDC worker audience and bounded SDK timeout', async () => {
    const client = { createTask: vi.fn(async () => []), getTask: vi.fn(async () => []) };
    const queue = new CloudTasksQueue(config, silentLog(), client);
    const p = payload();
    await queue.enqueue(p, signal());
    const [request, options] = client.createTask.mock.calls[0]! as unknown as Parameters<TasksClient['createTask']>;
    expect(options).toEqual({ timeout: 2000 });
    expect(request).toMatchObject({ parent: 'projects/qp-test-project/locations/europe-west1/queues/qp-process', task: {
      name: `projects/qp-test-project/locations/europe-west1/queues/qp-process/tasks/r-${p.requestId}-1`,
      dispatchDeadline: { seconds: 30 }, httpRequest: { httpMethod: 'POST', url: `${config.workerUrl}/internal/tasks`,
        oidcToken: { serviceAccountEmail: config.serviceAccount, audience: config.audience } } } });
    expect(JSON.parse(Buffer.from(request.task.httpRequest.body, 'base64').toString())).toEqual(p);
  });
  it.each([6, 'ALREADY_EXISTS'])('normalizes %s to successful creation, including tombstones', async (code) => {
    const queue = new CloudTasksQueue(config, silentLog(), { createTask: async () => { throw { code }; }, getTask: async () => [] });
    await expect(queue.enqueue(payload(), signal())).resolves.toBeUndefined();
  });
  it.each([[5, 'NOT_FOUND'], ['NOT_FOUND', 'NOT_FOUND'], [7, 'UNKNOWN'], ['PERMISSION_DENIED', 'UNKNOWN'], [14, 'UNKNOWN'], [undefined, 'UNKNOWN']])(
    'maps probe error %s to %s', async (code, result) => {
      const queue = new CloudTasksQueue(config, silentLog(), { createTask: async () => [], getTask: async () => { throw { code }; } });
      expect(await queue.probe(randomUUID(), 2)).toMatchObject({ seq: 2, result });
    });
  it('reports EXISTS; logs failures without SDK messages, descriptions or credentials', async () => {
    let output = '';
    const log = createLogger({ write: (line) => { output += line; } });
    const queue = new CloudTasksQueue(config, log, { createTask: async () => { throw { code: 14, message: 'SECRET DESCRIPTION' }; }, getTask: async () => [] });
    const p = payload();
    expect(await queue.probe(p.requestId, 1)).toEqual({ seq: 1, result: 'EXISTS' });
    await expect(queue.enqueue(p, signal())).rejects.toThrow('ENQUEUE_FAILED:14');
    expect(JSON.parse(output)).toMatchObject({ code: 'ENQUEUE_FAILED', correlationId: p.correlationId, requestId: p.requestId, seq: 1 });
    expect(output).not.toContain('SECRET');
  });
  it('rejects unsafe configuration and aborted enqueue before calling SDK', async () => {
    expect(() => new CloudTasksQueue({ ...config, audience: 'https://foreign.test' }, silentLog())).toThrow();
    expect(() => new CloudTasksQueue({ ...config, workerUrl: 'http://worker.test' }, silentLog())).toThrow();
    const client = { createTask: vi.fn(async () => []), getTask: async () => [] };
    const queue = new CloudTasksQueue(config, silentLog(), client);
    await expect(queue.enqueue(payload(), AbortSignal.abort())).rejects.toThrow();
    expect(client.createTask).not.toHaveBeenCalled();
  });
});

describe('LocalDispatchQueue deterministic transport model', () => {
  function fixture(options = {}) {
    let now = 1_000_000;
    const queue = new LocalDispatchQueue({ now: () => now }, { environment: 'test', ...options });
    return { queue, advance: (ms: number) => { now += ms; } };
  }
  it('models ambiguous creation, getTask, delete-on-2xx and expiring name tombstones', async () => {
    const { queue, advance } = fixture();
    const p = payload(); queue.faults.create = 'ambiguous';
    await expect(queue.enqueue(p, signal())).rejects.toThrow('AMBIGUOUS');
    expect(await queue.probe(p.requestId, 1)).toMatchObject({ result: 'EXISTS' });
    delete queue.faults.create;
    await queue.enqueue(p, signal()); expect(queue.size()).toBe(1);
    await queue.pump(async () => 200);
    expect(await queue.probe(p.requestId, 1)).toMatchObject({ result: 'NOT_FOUND' });
    await queue.enqueue(p, signal()); expect(queue.size()).toBe(0);
    advance(3_600_000); await queue.enqueue(p, signal()); expect(queue.size()).toBe(1);
    queue.purge(); expect(queue.size()).toBe(0);
  });
  it('deletes retries only after BOTH attempt and duration limits; counts pre-lease failures', async () => {
    const { queue, advance } = fixture({ maxAttempts: 3, maxRetryDurationMs: 120_000 });
    await queue.enqueue(payload(), signal());
    const deliver = vi.fn(async () => 503);
    await queue.pump(deliver); advance(2000); await queue.pump(deliver); advance(4000); await queue.pump(deliver);
    expect(deliver).toHaveBeenCalledTimes(3); expect(queue.size()).toBe(1);
    advance(120_000); await queue.pump(deliver); expect(queue.size()).toBe(0);
    const other = fixture({ maxAttempts: 3, maxRetryDurationMs: 1000 });
    await other.queue.enqueue(payload(), signal());
    await other.queue.pump(async () => { throw new Error('infra'); }); other.advance(2000);
    await other.queue.pump(async (_p, headers) => { expect(headers['x-cloudtasks-taskretrycount']).toBe('1'); return 409; });
    expect(other.queue.size()).toBe(1); other.advance(4000); await other.queue.pump(async () => 503);
    expect(other.queue.size()).toBe(0);
  });
  it('honours pause, concurrency, rate, 409 backoff, purge-in-flight and delivery deadline', async () => {
    const { queue, advance } = fixture({ rate: 2, concurrency: 1 });
    await Promise.all([queue.enqueue(payload(), signal()), queue.enqueue(payload(), signal()), queue.enqueue(payload(), signal())]);
    queue.pause(); expect(await queue.pump(async () => 200)).toBe(0); queue.resume();
    let release!: () => void;
    const inFlight = queue.pump(async () => { await new Promise<void>((resolve) => { release = resolve; }); return 200; });
    expect(await queue.pump(async () => 200)).toBe(0); release(); await inFlight;
    expect(await queue.pump(async () => 409)).toBe(1);
    expect(await queue.pump(async () => 200)).toBe(0);
    advance(1000); expect(await queue.pump(async () => 200)).toBe(1);
    advance(1000); await queue.pump(async () => { advance(30_001); return 200; }); expect(queue.size()).toBe(1);
    advance(4000); await queue.pump(async () => { queue.purge(); return 503; }); expect(queue.size()).toBe(0);
  });
  it('fault injection and local adapter can never start in production', () => {
    expect(() => new LocalDispatchQueue({ now: () => 0 }, { environment: 'production' })).toThrow();
    const production = { QP_ENV: 'production', GCLOUD_PROJECT: config.project, QP_WORKER_URL: config.workerUrl,
      QP_TASKS_OIDC_AUDIENCE: config.audience, QP_TASKS_INVOKER_SA: config.serviceAccount };
    expect(loadConfig(production).QP_QUEUE_ADAPTER).toBe('cloud');
    expect(() => loadConfig({ ...production, QP_QUEUE_ADAPTER: 'local' })).toThrow();
    expect(() => loadConfig({ ...production, QP_FAULT_CREATE: 'false' })).toThrow();
    expect(() => loadConfig({ ...production, QP_WORKER_AUTH_MODE: 'local' })).toThrow();
    expect(() => loadConfig({ QP_WORKER_AUTH_MODE: 'local' })).toThrow();
  });
  it('a fake-clock deadline releases a hung delivery; its late 2xx cannot acknowledge the retry', async () => {
    const { queue, advance } = fixture();
    await queue.enqueue(payload(), signal());
    let release!: () => void;
    const hung = queue.pump(async () => { await new Promise<void>((resolve) => { release = resolve; }); return 200; });
    await Promise.resolve(); await Promise.resolve();
    advance(30_000); expect(await queue.pump(async () => 200)).toBe(0);
    await hung; expect(queue.size()).toBe(1);
    release(); await Promise.resolve(); expect(queue.size()).toBe(1);
    advance(2000); await queue.pump(async () => 200); expect(queue.size()).toBe(0);
  });
});
