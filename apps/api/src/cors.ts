import type { FastifyReply, FastifyRequest } from 'fastify';
import { HEADERS } from '@queuepilot/contracts';

/** What the routes accept: GET and POST only (see app.ts). */
export const CORS_ALLOWED_METHODS = 'GET, POST, OPTIONS';
/**
 * Request headers the API reads: the bearer token, the JSON content type and the idempotency key. `Accept` is
 * safelisted by browsers. Listed explicitly, never echoed from the preflight.
 */
export const CORS_ALLOWED_HEADERS = 'Authorization, Content-Type, Idempotency-Key';
/** Response headers the web client reads. Retry-After is required; the others are hidden from scripts otherwise. */
export const CORS_EXPOSED_HEADERS = [HEADERS.retryAfter, HEADERS.idempotentReplayed, HEADERS.correlationId, HEADERS.location].join(', ');
/** Ten minutes: long enough to spare a preflight per call, short enough that a changed list takes effect soon. Browsers cap it anyway. */
export const CORS_MAX_AGE_SECONDS = 600;

/**
 * Allow-list CORS for browsers on another origin (Firebase Hosting). Exact string matches against the validated
 * `QP_CORS_ORIGINS`; the answer is the matching entry itself, never `*` and never an arbitrary echo. Credentials are
 * never allowed (auth is a bearer token). Every response varies on Origin. A request from another origin is not
 * blocked here (CORS is a browser rule, not authentication); it simply gets no CORS headers.
 * Register as the first `onRequest` hook: a preflight carries no token and ends here, before authentication.
 */
export function corsHook(allowed: readonly string[]) {
  const origins = new Set(allowed);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('vary', 'Origin');
    const origin = request.headers.origin;
    const permitted = typeof origin === 'string' && origins.has(origin);
    if (permitted) reply.header('access-control-allow-origin', origin).header('access-control-expose-headers', CORS_EXPOSED_HEADERS);
    if (origin !== undefined && request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined) {
      if (permitted) {
        reply.header('access-control-allow-methods', CORS_ALLOWED_METHODS).header('access-control-allow-headers', CORS_ALLOWED_HEADERS)
          .header('access-control-max-age', String(CORS_MAX_AGE_SECONDS));
      }
      return reply.status(204).send();
    }
  };
}
