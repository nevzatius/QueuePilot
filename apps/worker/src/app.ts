import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TaskPayloadSchema } from '@queuepilot/contracts';
import { logOptions } from '@queuepilot/core';
import type { CallerVerifier, ProcessingStore, Reconciler, WorkerService } from '@queuepilot/core';

export type WorkerDependencies = {
  verifier: CallerVerifier; store: ProcessingStore; worker: WorkerService; reconciler: Reconciler; logger?: boolean;
};
const taskCounter = (value: unknown) => typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : undefined;

export function buildWorkerApp(deps: WorkerDependencies) {
  const app = Fastify({ logger: deps.logger === false ? false : logOptions,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }), genReqId: () => randomUUID(),
    bodyLimit: 4096, trustProxy: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id).header('cache-control', 'no-store');
    const path = request.routeOptions.url;
    if (path === '/ready' || path === '/health') return;
    const caller = path === '/internal/reconcile' ? 'scheduler' : 'tasks';
    if (!await deps.verifier.verify(request.headers.authorization, caller)) return reply.code(403).send({ code: 'FORBIDDEN' });
  });
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error !== null && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const invalid = error instanceof Error && ('validation' in error
      || (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500));
    request.log.error({ code: invalid ? 'INVALID_TASK' : 'WORKER_IO_FAILED' }, 'Worker request failed');
    // No raw errors, bodies or tokens in logs or responses. Commit failures must remain retryable.
    void reply.code(invalid ? 400 : 503).send({ code: invalid ? 'INVALID_TASK' : 'UNAVAILABLE' });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async () => { await deps.store.health(); return { status: 'ready' }; });
  app.post('/internal/tasks', { schema: { body: TaskPayloadSchema } }, async (request, reply) => {
    request.log.info({ correlationId: request.body.correlationId, requestId: request.body.requestId,
      tenantId: request.body.tenantId, seq: request.body.seq, taskRetryCount: taskCounter(request.headers['x-cloudtasks-taskretrycount']),
      taskExecutionCount: taskCounter(request.headers['x-cloudtasks-taskexecutioncount']) }, 'Task delivery received');
    const result = await deps.worker.deliver(request.body);
    return reply.code(result.http).send({ code: result.kind });
  });
  app.post('/internal/reconcile', async () => deps.reconciler.run());
  return app;
}
