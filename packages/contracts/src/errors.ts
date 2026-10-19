import { z } from 'zod';
import { CorrelationIdSchema } from './common.js';

/**
 * Error catalog: every API error code with its HTTP status and a stable, human-readable title.
 * Adding a code is additive; changing a status or removing a code requires a CCR.
 */
export const ERROR_CATALOG = {
  VALIDATION_FAILED: { status: 400, title: 'Request validation failed' },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  ONBOARDING_REQUIRED: { status: 403, title: 'Onboarding required' },
  SIGNUP_CLOSED: { status: 403, title: 'Sign-up is closed' },
  MEMBERSHIP_SUSPENDED: { status: 403, title: 'Membership suspended' },
  TENANT_SUSPENDED: { status: 403, title: 'Tenant suspended' },
  NOT_FOUND: { status: 404, title: 'Resource not found' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, title: 'Idempotency key reused with a different payload' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  QUOTA_EXCEEDED: { status: 429, title: 'Submission quota exceeded' },
  INTERNAL_ERROR: { status: 500, title: 'Internal server error' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service temporarily unavailable' },
  QUOTA_UNAVAILABLE: { status: 503, title: 'Submission quota temporarily unavailable' },
  OVERLOADED: { status: 503, title: 'Ingestion overloaded' },
  BACKLOG_FULL: { status: 503, title: 'Processing backlog is full' },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** Problem type URIs are URNs, so they never imply a hosted documentation page. */
const PROBLEM_TYPE_PREFIX = 'urn:queuepilot:problem:';

export function problemTypeUri(code: ErrorCode): string {
  return `${PROBLEM_TYPE_PREFIX}${code.toLowerCase().replaceAll('_', '-')}`;
}

/** A single validation failure. `pointer` is a JSON Pointer into the body, or `header:<name>` / `query:<name>`. */
export const ProblemIssueSchema = z.object({
  pointer: z.string().max(256),
  message: z.string().max(512),
});
export type ProblemIssue = z.infer<typeof ProblemIssueSchema>;

/**
 * RFC 9457 Problem Details (`application/problem+json`) with QueuePilot extension members.
 * Stack traces and internal error messages never appear here.
 */
export const ProblemDetailsSchema = z
  .object({
    type: z.string().min(1).max(256),
    title: z.string().min(1).max(256),
    status: z.number().int().min(400).max(599),
    detail: z.string().max(1024).optional(),
    instance: z.string().max(512).optional(),
    code: ErrorCodeSchema,
    correlationId: CorrelationIdSchema,
    /** Present for VALIDATION_FAILED. */
    errors: z.array(ProblemIssueSchema).max(50).optional(),
    /** Mirrors the `Retry-After` header on 429/503 responses. */
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  })
  .refine((p) => p.status === ERROR_CATALOG[p.code].status, {
    message: 'status does not match the error code',
    path: ['status'],
  });
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface CreateProblemInput {
  code: ErrorCode;
  correlationId: string;
  detail?: string;
  instance?: string;
  errors?: ProblemIssue[];
  retryAfterSeconds?: number;
}

/** Builds a Problem Details body whose `type`, `title` and `status` always agree with the catalog. */
export function createProblem(input: CreateProblemInput): ProblemDetails {
  const entry = ERROR_CATALOG[input.code];
  return {
    type: problemTypeUri(input.code),
    title: entry.title,
    status: entry.status,
    code: input.code,
    correlationId: input.correlationId,
    ...(input.detail !== undefined && { detail: input.detail }),
    ...(input.instance !== undefined && { instance: input.instance }),
    ...(input.errors !== undefined && { errors: input.errors }),
    ...(input.retryAfterSeconds !== undefined && { retryAfterSeconds: input.retryAfterSeconds }),
  };
}
