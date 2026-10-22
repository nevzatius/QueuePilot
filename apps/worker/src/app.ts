import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { TaskPayloadSchema } from '@queuepilot/contracts';
import { LEASE_MS, RETRY_WATCHDOG_MS } from '@queuepilot/domain';
import { isDeliveryVerifier, logOptions, WORKER_RECONCILE_PATH, WORKER_TASKS_PATH } from '@queuepilot/core';
import type { CallerVerifier, ProcessingStore, Reconciler, WorkerCaller, WorkerService } from '@queuepilot/core';

export type WorkerDependencies = {
  verifier: CallerVerifier; store: ProcessingStore; worker: WorkerService; reconciler: Reconciler; logger?: boolean;
  /** Tests: capture the log lines instead of writing them to stdout. */
  logStream?: { write(message: string): void };
};
/**
 * `Retry-After` (seconds) on a 409 or 503 answer to a delivery. QStash honours it (ADR-019, measured), so the
 * retry lands when it can change something instead of at QStash's default backoff (about 12 s, then 154 s),
 * and every retry costs a message of the free daily budget. Only the header is new: when the worker answers
 * 409/503 and what it does with the job is unchanged.
 * - 409 (lease held by another delivery, or this delivery was fenced): equals LEASE_MS (60 s), the holder's
 *   lease, so an earlier retry would meet the same lease.
 * - 503 (transient processing failure, or Firestore unavailable): equals RETRY_WATCHDOG_MS (300 s). It is not
 *   derived from QStash or from the reconciler's cadence; it only reuses the request's own watchdog interval.
 */
export const RETRY_AFTER_SECONDS = { 409: LEASE_MS / 1000, 503: RETRY_WATCHDOG_MS / 1000 } as const;
const headerValue = (value: string | string[] | undefined) => typeof value === 'string' ? value : undefined;
const isInternal = (path: string | undefined) => path === WORKER_TASKS_PATH || path === WORKER_RECONCILE_PATH;
/** Routes that never go through the bearer check: probes everywhere, and under a delivery verifier the two routes that verify by signature. */
const OPEN_PATHS: readonly string[] = ['/health', '/ready'];
const taskCounter = (value: unknown) => typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : undefined;

export function buildWorkerApp(deps: WorkerDependencies) {
  const app = Fastify({ logger: deps.logger === false ? false : deps.logStream ? { ...logOptions, stream: deps.logStream } : logOptions,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }), genReqId: () => randomUUID(),
    bodyLimit: 4096, trustProxy: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Under a delivery verifier (QStash) the signature covers the raw body, so verification cannot happen in
  // `onRequest`; it runs in `preValidation` of each protected route, after the body is buffered and before
  // anything is parsed or validated. Under OIDC nothing changes.
  const delivery = isDeliveryVerifier(deps.verifier) ? deps.verifier : undefined;
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id).header('cache-control', 'no-store');
    const path = request.routeOptions.url;
    // An allow-list, not a mode switch: in delivery mode only the probes and the two signature-verified routes
    // skip this hook; any other route (or an unmatched one) falls through to the bearer check, which a delivery verifier never accepts.
    if (path !== undefined && (OPEN_PATHS.includes(path) || (delivery && isInternal(path)))) return;
    const caller = path === WORKER_RECONCILE_PATH ? 'scheduler' : 'tasks';
    if (!await deps.verifier.verify(request.headers.authorization, caller)) return reply.code(403).send({ code: 'FORBIDDEN' });
  });
  // Requests whose signature has been verified; an error on an internal route before this point is unauthenticated by definition.
  const verified = new WeakSet<FastifyRequest>();
  app.setErrorHandler((error, request, reply) => {
    if (delivery && isInternal(request.routeOptions.url) && !verified.has(request)) {
      // Content-type, body-limit and Content-Length failures fire before `preValidation` can verify anything. An
      // unsigned (or unverifiable) request must not learn anything from the status: 401, like every other rejection.
      request.log.warn({ code: 'CALLER_REJECTED', reason: 'BAD_FORMAT', caller: request.routeOptions.url === WORKER_RECONCILE_PATH ? 'scheduler' : 'tasks' }, 'Caller verification failed');
      return reply.code(delivery.rejectStatus).send({ code: 'UNAUTHENTICATED' });
    }
    const statusCode = error !== null && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const invalid = error instanceof Error && ('validation' in error
      || (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500));
    request.log.error({ code: invalid ? 'INVALID_TASK' : 'WORKER_IO_FAILED' }, 'Worker request failed');
    // No raw errors, bodies or tokens in logs or responses. Commit failures must remain retryable.
    if (!invalid && isInternal(request.routeOptions.url)) void reply.header('retry-after', String(RETRY_AFTER_SECONDS[503]));
    void reply.code(invalid ? 400 : 503).send({ code: invalid ? 'INVALID_TASK' : 'UNAVAILABLE' });
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async () => { await deps.store.health(); return { status: 'ready' }; });
  app.register(async (scope) => {
    const routes = scope.withTypeProvider<ZodTypeProvider>();
    let guard: (caller: WorkerCaller, parse: boolean) => object = () => ({});
    if (delivery) {
      // The framework's raw-body mechanism, for these routes only (this scope): every content type is handed
      // over as the exact received bytes, never parsed or re-serialised, so an unsigned request cannot fail
      // earlier with a 400/415 and the signature always sees what QStash signed.
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 4096 }, (_request, body, done) => { done(null, body); });
      // Fastify's own JSON parser (prototype-poisoning guard included), run on the verified bytes.
      const defaultJson = scope.getDefaultJsonParser('error', 'error');
      const parseJson = (request: FastifyRequest, text: string) => new Promise<unknown>((resolve, reject) => {
        defaultJson(request, text, (error, value) => { if (error) reject(error); else resolve(value); });
      });
      guard = (caller, parse) => ({ preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const outcome = delivery.check({ signature: headerValue(request.headers['upstash-signature']), rawBody: raw }, caller);
        if (!outcome.ok) {
          // The reason is a code, never the token, a key or a claim.
          request.log.warn({ code: 'CALLER_REJECTED', reason: outcome.reason, caller }, 'Caller verification failed');
          return reply.code(delivery.rejectStatus).send({ code: 'UNAUTHENTICATED' });
        }
        verified.add(request);
        request.body = parse && raw.length > 0 ? await parseJson(request, raw.toString('utf8')) : undefined;
      } });
    }
    routes.post(WORKER_TASKS_PATH, { schema: { body: TaskPayloadSchema }, ...guard('tasks', true) }, async (request, reply) => {
      request.log.info({ correlationId: request.body.correlationId, requestId: request.body.requestId,
        tenantId: request.body.tenantId, seq: request.body.seq, taskRetryCount: taskCounter(request.headers['x-cloudtasks-taskretrycount']),
        taskExecutionCount: taskCounter(request.headers['x-cloudtasks-taskexecutioncount']) }, 'Task delivery received');
      const result = await deps.worker.deliver(request.body);
      if (result.http === 409 || result.http === 503) void reply.header('retry-after', String(RETRY_AFTER_SECONDS[result.http]));
      return reply.code(result.http).send({ code: result.kind });
    });
    routes.post(WORKER_RECONCILE_PATH, { ...guard('scheduler', false) }, async () => deps.reconciler.run());
  });
  return app;
}
