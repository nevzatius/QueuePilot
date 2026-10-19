import { GoogleAuth } from 'google-auth-library';
import type { TasksClient, CreateTaskRequest } from './cloud.js';

export type TasksHttpRequest = { method: 'GET' | 'POST'; url: string; data?: object; timeout: number; retry: false };
export interface TasksAuthSource {
  getClient(): Promise<{ request(options: TasksHttpRequest): Promise<unknown> }>;
}

/** Cloud Tasks v2 REST transport. ADC is resolved only on a real cloud call, never at startup. */
export class RestTasksClient implements TasksClient {
  constructor(private readonly auth: TasksAuthSource = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })) {}
  async createTask(request: CreateTaskRequest, options: { timeout: number }): Promise<unknown> {
    return this.call('POST', `${request.parent}/tasks`, {
      task: { ...request.task, dispatchDeadline: `${request.task.dispatchDeadline.seconds}s` },
    }, options.timeout);
  }
  async getTask(request: { name: string }, options: { timeout: number }): Promise<unknown> {
    return this.call('GET', request.name, undefined, options.timeout);
  }
  private async call(method: 'GET' | 'POST', path: string, data: object | undefined, timeout: number) {
    try {
      const client = await this.auth.getClient();
      return await client.request({ method, url: `https://cloudtasks.googleapis.com/v2/${path}`,
        ...(data !== undefined && { data }), timeout, retry: false });
    } catch (error) {
      // REST reports HTTP status; the adapter exposes the same gRPC-style codes as TasksClient.
      const status = error !== null && typeof error === 'object' && 'response' in error
        ? (error.response as { status?: number } | undefined)?.status : undefined;
      throw { code: status === 404 ? 'NOT_FOUND' : status === 409 ? 'ALREADY_EXISTS'
        : status === 403 ? 'PERMISSION_DENIED' : status === 401 ? 'UNAUTHENTICATED' : status ?? 'UNKNOWN' };
    }
  }
}
