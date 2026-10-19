import type { TaskPayload } from '@queuepilot/contracts';

/** B4 supplies CloudTasks/LocalDispatchQueue. Only the committed acceptance creator calls seq=1. */
export interface QueuePort {
  enqueue(payload: TaskPayload, signal: AbortSignal): Promise<void>;
}
export const deferredQueue: QueuePort = {
  enqueue: async () => { throw new Error('B4 queue adapter is not connected'); },
};

/** Bound API latency even when an adapter ignores cancellation. The name remains unique on late completion. */
export async function enqueueAccepted(queue: QueuePort, payload: TaskPayload, timeoutMs = 2000): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => queue.enqueue(payload, controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Enqueue timeout')); }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
