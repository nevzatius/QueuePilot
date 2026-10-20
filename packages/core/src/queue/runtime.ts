import type { Clock } from '@queuepilot/domain';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { CloudTasksQueue } from './cloud.js';
import { LocalDispatchQueue } from './local.js';

export function createDispatchQueue(config: Config, clock: Clock, log: Logger) {
  if (config.QP_QUEUE_ADAPTER === 'cloud') return new CloudTasksQueue({
    project: config.GCLOUD_PROJECT, region: config.QP_REGION, queue: config.QP_TASKS_QUEUE,
    workerUrl: config.QP_WORKER_URL, audience: config.QP_TASKS_OIDC_AUDIENCE!,
    serviceAccount: config.QP_TASKS_INVOKER_SA!, deadlineSeconds: config.QP_TASK_DISPATCH_DEADLINE_SECONDS,
  }, log);
  // No silent fallback: selecting qstash before its adapter exists must stop startup.
  if (config.QP_QUEUE_ADAPTER === 'qstash') throw new Error('QP_QUEUE_ADAPTER=qstash is not available yet: the QStashQueue adapter lands in B9-2');
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
        signal: AbortSignal.timeout(30_000) });
      await response.body?.cancel();
      return response.status;
    }).catch(() => { log.error({ code: 'LOCAL_DISPATCH_FAILED', correlationId: 'local-dispatch' }, 'Local dispatch failed'); }).finally(() => { busy = false; });
  }, 100);
  timer.unref();
  return async () => { clearInterval(timer); await inFlight; };
}
