import type { Clock } from '@queuepilot/domain';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { CloudTasksQueue } from './cloud.js';
import { LocalDispatchQueue } from './local.js';
import { parseRetryAfter, QStashQueue } from './qstash.js';

export function createDispatchQueue(config: Config, clock: Clock, log: Logger) {
  if (config.QP_QUEUE_ADAPTER === 'cloud') return new CloudTasksQueue({
    project: config.GCLOUD_PROJECT, region: config.QP_REGION, queue: config.QP_TASKS_QUEUE,
    workerUrl: config.QP_WORKER_URL, audience: config.QP_TASKS_OIDC_AUDIENCE!,
    serviceAccount: config.QP_TASKS_INVOKER_SA!, deadlineSeconds: config.QP_TASK_DISPATCH_DEADLINE_SECONDS,
  }, log);
  if (config.QP_QUEUE_ADAPTER === 'qstash') {
    // loadConfig already rejects a missing token; this stays as the last line against a hand-built Config.
    if (!config.QSTASH_TOKEN) throw new Error('QStash queue requires QSTASH_TOKEN');
    return new QStashQueue({ token: config.QSTASH_TOKEN, baseUrl: config.QSTASH_URL, workerUrl: config.QP_WORKER_URL,
      retries: config.QP_QSTASH_RETRIES, timeout: config.QP_QSTASH_TIMEOUT }, log, clock);
  }
  if (config.QP_ENV === 'production') throw new Error('Production requires Cloud Tasks');
  return new LocalDispatchQueue(clock, { environment: config.QP_ENV, faults: {
    ...(process.env.QP_FAULT_CREATE === 'fail' && { create: 'fail' }),
    ...(process.env.QP_FAULT_CREATE === 'ambiguous' && { create: 'ambiguous' }),
    ...(process.env.QP_FAULT_PROBE_PERMISSION_DENIED && { permissionDenied: true }),
  } });
}

/** Local development transport. The queue model itself remains timer-free. */
export function startLocalDispatch(queue: LocalDispatchQueue, workerUrl: string, log: Logger): () => Promise<void> {
  let inFlight: Promise<unknown> = Promise.resolve();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    inFlight = queue.pump(async (payload, headers) => {
      const response = await fetch(`${workerUrl}/internal/tasks`, { method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload),
        // Longer than the queue's own wait, so the queue gives up first and the handler is not cut off.
        signal: AbortSignal.timeout(queue.deadlineMs + 5000) });
      await response.body?.cancel();
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'), Date.now());
      return retryAfterSeconds === undefined ? response.status : { status: response.status, retryAfterSeconds };
    }).catch(() => { log.error({ code: 'LOCAL_DISPATCH_FAILED', correlationId: 'local-dispatch' }, 'Local dispatch failed'); }).finally(() => { busy = false; });
  }, 100);
  timer.unref();
  return async () => { clearInterval(timer); await inFlight; };
}
