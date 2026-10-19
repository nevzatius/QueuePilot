import { describe, expect, it, vi } from 'vitest';
import { RestTasksClient } from '@queuepilot/core';
import type { TasksHttpRequest } from '@queuepilot/core';

describe('Cloud Tasks REST wire format (offline)', () => {
  it('uses v2 named task URLs, protobuf JSON duration and base64 JSON body with no transport retries', async () => {
    const request = vi.fn<(options: TasksHttpRequest) => Promise<unknown>>(async () => ({}));
    const auth = { getClient: vi.fn(async () => ({ request })) };
    const client = new RestTasksClient(auth);
    expect(auth.getClient).not.toHaveBeenCalled();
    const parent = 'projects/qp-demo/locations/europe-west1/queues/qp-process';
    const task = { name: `${parent}/tasks/r-id-1`, dispatchDeadline: { seconds: 30 },
      httpRequest: { httpMethod: 'POST' as const, url: 'https://worker.example.test/internal/tasks',
        headers: { 'Content-Type': 'application/json' }, body: 'e30=',
        oidcToken: { serviceAccountEmail: 'invoker@qp-demo.iam.gserviceaccount.com', audience: 'https://worker.example.test' } } };
    await client.createTask({ parent, task }, { timeout: 2000 });
    expect(request).toHaveBeenCalledWith({ method: 'POST', url: `https://cloudtasks.googleapis.com/v2/${parent}/tasks`,
      data: { task: { ...task, dispatchDeadline: '30s' } }, timeout: 2000, retry: false });
    await client.getTask({ name: task.name }, { timeout: 2000 });
    expect(request).toHaveBeenLastCalledWith({ method: 'GET', url: `https://cloudtasks.googleapis.com/v2/${task.name}`, timeout: 2000, retry: false });
  });
  it.each([[404, 'NOT_FOUND'], [409, 'ALREADY_EXISTS'], [403, 'PERMISSION_DENIED'], [401, 'UNAUTHENTICATED'], [503, 503]])(
    'maps HTTP %s to %s without exposing response bodies', async (status, code) => {
      const client = new RestTasksClient({ getClient: async () => ({ request: async () => { throw { response: { status, data: 'SECRET' } }; } }) });
      await expect(client.getTask({ name: 'projects/qp-demo/locations/europe-west1/queues/qp-process/tasks/test' }, { timeout: 2000 })).rejects.toEqual({ code });
    });
});
