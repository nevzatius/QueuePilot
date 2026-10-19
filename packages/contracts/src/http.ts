import { z } from 'zod';

/** Pagination query, shared by every list endpoint. The cursor is opaque and issued by the server. */
export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,512}$/, 'invalid cursor')
    .optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/** Builds a page envelope schema. `nextCursor` is null on the last page. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item).max(100),
    nextCursor: z.string().min(1).max(512).nullable(),
  });
}

export const API_PREFIX = '/api/v1';

export const API_PATHS = {
  me: `${API_PREFIX}/me`,
  bootstrap: `${API_PREFIX}/session/bootstrap`,
  requests: `${API_PREFIX}/requests`,
  metrics: `${API_PREFIX}/metrics`,
} as const;

/** Canonical URL of a single request, used for the `Location` header and `statusUrl`. */
export function requestPath(requestId: string): string {
  return `${API_PATHS.requests}/${requestId}`;
}

/** Header names are lower case because Fastify (Node) normalises incoming headers. */
export const HEADERS = {
  idempotencyKey: 'idempotency-key',
  idempotentReplayed: 'idempotent-replayed',
  correlationId: 'x-correlation-id',
  retryAfter: 'retry-after',
  location: 'location',
} as const;
