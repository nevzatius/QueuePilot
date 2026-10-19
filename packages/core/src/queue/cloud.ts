import { TaskPayloadSchema } from '@queuepilot/contracts';
import type { TaskPayload } from '@queuepilot/contracts';
import { taskName } from '@queuepilot/domain';
import type { TaskProbe } from '@queuepilot/domain';
import type { Logger } from 'pino';
import type { DispatchQueue } from '../queue.js';

export type CloudQueueConfig = {
  project: string; region: string; queue: string; workerUrl: string; audience: string;
  serviceAccount: string; deadlineSeconds: number;
};
export type CreateTaskRequest = {
  parent: string;
  task: { name: string; dispatchDeadline: { seconds: number }; httpRequest: {
    httpMethod: 'POST'; url: string; headers: Record<string, string>; body: string;
    oidcToken: { serviceAccountEmail: string; audience: string };
  } };
};
/** Structural seam keeps the SDK lazy and lets offline tests inject a client. */
export interface TasksClient {
  createTask(request: CreateTaskRequest, options: { timeout: number }): Promise<unknown>;
  getTask(request: { name: string }, options: { timeout: number }): Promise<unknown>;
}
export function queueErrorCode(error: unknown): string {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const value = typeof code === 'string' || typeof code === 'number' ? String(code) : '';
  return /^(?:[A-Z][A-Z_0-9]{0,63}|\d{1,3})$/.test(value) ? value : 'UNKNOWN';
}

export class CloudTasksQueue implements DispatchQueue {
  private client: Promise<TasksClient> | undefined;
  private readonly parent: string;
  constructor(private readonly config: CloudQueueConfig, private readonly log: Logger, client?: TasksClient) {
    const url = new URL(config.workerUrl);
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(config.project) || !/^[a-z]+-[a-z]+\d+$/.test(config.region)
        || !/^[A-Za-z0-9_-]{1,100}$/.test(config.queue) || url.protocol !== 'https:' || url.origin !== config.workerUrl
        || config.audience !== config.workerUrl
        || !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(config.serviceAccount)
        || !Number.isInteger(config.deadlineSeconds) || config.deadlineSeconds < 15 || config.deadlineSeconds > 30) {
      throw new Error('Invalid Cloud Tasks configuration');
    }
    this.parent = `projects/${config.project}/locations/${config.region}/queues/${config.queue}`;
    if (client) this.client = Promise.resolve(client);
  }
  private getClient(): Promise<TasksClient> {
    return this.client ??= import('./rest.js').then(({ RestTasksClient }) => new RestTasksClient());
  }
  async enqueue(input: TaskPayload, signal: AbortSignal): Promise<void> {
    const payload = TaskPayloadSchema.parse(input);
    try {
      signal.throwIfAborted();
      const client = await this.getClient();
      signal.throwIfAborted();
      await client.createTask({
        parent: this.parent,
        task: {
          name: `${this.parent}/tasks/${taskName(payload.requestId, payload.seq)}`,
          dispatchDeadline: { seconds: this.config.deadlineSeconds },
          httpRequest: {
            httpMethod: 'POST', url: `${this.config.workerUrl}/internal/tasks`,
            headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(payload)).toString('base64'),
            oidcToken: { serviceAccountEmail: this.config.serviceAccount, audience: this.config.audience },
          },
        },
      }, { timeout: 2000 });
    } catch (error) {
      const code = queueErrorCode(error);
      if (code === '6' || code === 'ALREADY_EXISTS') return;
      // Never log SDK messages: they can contain HTTP bodies or credentials.
      this.log.error({ ...payload, code: 'ENQUEUE_FAILED', errorCode: code }, 'Task creation failed');
      // eslint-disable-next-line preserve-caught-error -- SDK errors may contain credentials or request bodies.
      throw new Error(`ENQUEUE_FAILED:${code}`);
    }
  }
  async probe(requestId: string, seq: number): Promise<TaskProbe> {
    try {
      await (await this.getClient()).getTask({ name: `${this.parent}/tasks/${taskName(requestId, seq)}` }, { timeout: 2000 });
      return { seq, result: 'EXISTS' };
    } catch (error) {
      const errorCode = queueErrorCode(error);
      if (errorCode === '5' || errorCode === 'NOT_FOUND') return { seq, result: 'NOT_FOUND' };
      this.log.error({ requestId, correlationId: requestId, seq, code: 'PROBE_UNKNOWN', errorCode }, 'Task probe failed');
      return { seq, result: 'UNKNOWN', errorCode };
    }
  }
}
