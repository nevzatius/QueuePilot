import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  API_PATHS, BootstrapRequestSchema, BootstrapResponseSchema, CreateRequestBodySchema,
  CreateRequestResponseSchema, IdempotencyHeadersSchema, ListRequestsQuerySchema,
  ListRequestsResponseSchema, MeResponseSchema, MetricsResponseSchema, RequestDetailSchema,
  RequestIdParamsSchema, requestPath,
} from '@queuepilot/contracts';
import type { Membership } from '@queuepilot/contracts';
import {
  AdmissionControl, ApiError, bearerToken, enqueueAccepted, logOptions, MemoryRateLimiter,
  MetricsService, problemDetails, unavailableQuota,
} from '@queuepilot/core';
import type { Config, MembershipService, QuotaStore, RateLimiter, QueuePort, RequestRepository, Tenant, TokenVerifier } from '@queuepilot/core';

declare module 'fastify' {
  interface FastifyRequest {
    identity: { uid: string; email: string | null };
    access: { membership: Membership; tenant: Tenant };
  }
  interface FastifyContextConfig { public?: boolean; membership?: boolean }
}

export type AppDependencies = {
  config: Config; verifier: TokenVerifier; memberships: MembershipService; requests: RequestRepository;
  queue: QueuePort; admission: AdmissionControl; metrics: MetricsService; rateLimiter: RateLimiter;
  quota?: QuotaStore; bootstrapLimiter?: RateLimiter; logger?: boolean;
};

export function buildApp(deps: AppDependencies) {
  const app = Fastify({
    logger: deps.logger === false ? false : logOptions,
    logController: new LogController({ requestIdLogLabel: 'correlationId' }), genReqId: () => randomUUID(),
    bodyLimit: 32 * 1024, trustProxy: false,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('identity');
  app.decorateRequest('access');
  const bootstrapLimiter = deps.bootstrapLimiter ?? new MemoryRateLimiter({ now: () => Date.now() }, 1);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id).header('cache-control', 'no-store');
    if (request.routeOptions.config.public) return;
    request.identity = await deps.verifier.verify(bearerToken(request.headers.authorization));
    if (request.routeOptions.config.membership !== false) {
      request.access = await deps.memberships.require(request.identity.uid);
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const failure = error as { code?: string; statusCode?: number; validation?: unknown };
    const code = error instanceof ApiError ? error.code
      : failure.validation || ['FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_EMPTY_JSON_BODY', 'FST_ERR_CTP_INVALID_MEDIA_TYPE'].includes(failure.code ?? '') ? 'VALIDATION_FAILED'
      : failure.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR';
    const retryAfter = error instanceof ApiError ? error.retryAfter : undefined;
    const problem = { ...problemDetails(code, request.id), ...(retryAfter && { retryAfterSeconds: retryAfter }) };
    if (problem.status >= 500) request.log.error({ code }, 'API dependency or internal failure');
    if (retryAfter) reply.header('retry-after', retryAfter);
    reply.status(problem.status).type('application/problem+json').send(problem);
  });
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).type('application/problem+json').send(problemDetails('NOT_FOUND', request.id));
  });

  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));
  app.get('/ready', { config: { public: true } }, async () => { await deps.requests.health(); return { status: 'ok' }; });
  app.get(API_PATHS.me, { config: { membership: false }, schema: { response: { 200: MeResponseSchema } } }, async (request) => ({
    ...request.identity, membership: (await deps.memberships.lookup(request.identity.uid))?.membership ?? null,
  }));
  app.post(API_PATHS.bootstrap, {
    config: { membership: false }, schema: { response: { 200: BootstrapResponseSchema } },
    preValidation: async (request) => {
      // Fastify requires a body whenever a body schema is present, even for Zod.optional().
      if (!BootstrapRequestSchema.safeParse(request.body).success) throw new ApiError('VALIDATION_FAILED');
    },
  }, async (request) => {
    await bootstrapLimiter.consume(`uid:${request.identity.uid}`, 10);
    await bootstrapLimiter.consume(`ip:${request.ip}`, 30);
    const release = await deps.admission.acquire();
    try { return await deps.memberships.bootstrap(request.identity.uid); }
    finally { release(); }
  });
  app.post(API_PATHS.requests, {
    schema: { body: CreateRequestBodySchema, headers: IdempotencyHeadersSchema, response: { 202: CreateRequestResponseSchema } },
  }, async (request, reply) => {
    const { membership, tenant } = request.access;
    await deps.rateLimiter.consume(`${membership.tenantId}:${request.identity.uid}`, tenant.limits.submitPerMin);
    if (tenant.quotaMode === 'enforced') {
      await (deps.quota ?? unavailableQuota).consume(membership.tenantId, request.identity.uid, tenant.limits);
    }
    const release = await deps.admission.acquire(() => deps.metrics.backlog());
    let accepted;
    try {
      accepted = await deps.requests.submit({
        body: request.body, key: request.headers['idempotency-key'], tenantId: membership.tenantId,
        uid: request.identity.uid, correlationId: request.id,
      });
    } finally { release(); }
    if (!accepted.replayed) {
      try {
        await enqueueAccepted(deps.queue, { requestId: accepted.requestId, tenantId: membership.tenantId, seq: 1, correlationId: request.id });
      } catch {
        request.log.error({ requestId: accepted.requestId, tenantId: membership.tenantId, seq: 1, code: 'ENQUEUE_FAILED' }, 'Accepted request awaits reconciler');
      }
    } else reply.header('idempotent-replayed', 'true');
    const location = requestPath(accepted.requestId);
    return reply.status(202).header('location', location).send({ requestId: accepted.requestId, location });
  });
  app.get(API_PATHS.requests, {
    schema: { querystring: ListRequestsQuerySchema, response: { 200: ListRequestsResponseSchema } },
  }, async (request) => {
    const resolved = request.query.scope === 'tenant'
      ? await deps.memberships.require(request.identity.uid, true) : request.access;
    if (request.query.scope === 'tenant' && resolved.membership.role !== 'admin') throw new ApiError('FORBIDDEN');
    return deps.requests.list(resolved.membership, request.identity.uid, request.query);
  });
  app.get(`${API_PATHS.requests}/:requestId`, {
    schema: { params: RequestIdParamsSchema, response: { 200: RequestDetailSchema } },
  }, async (request) => {
    const resolved = request.access.membership.role === 'admin'
      ? await deps.memberships.require(request.identity.uid, true) : request.access;
    return deps.requests.detail(resolved.membership, request.identity.uid, request.params.requestId);
  });
  app.get(API_PATHS.metrics, { schema: { response: { 200: MetricsResponseSchema } } }, async (request) => deps.metrics.get(request.access.membership.tenantId));
  return app;
}
