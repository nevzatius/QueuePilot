import type { z } from 'zod';
import {
  API_PATHS,
  BootstrapResponseSchema,
  CreateRequestResponseSchema,
  HEADERS,
  IDEMPOTENT_REPLAYED_VALUE,
  ListRequestsResponseSchema,
  MeResponseSchema,
  MetricsResponseSchema,
  ProblemDetailsSchema,
  RequestDetailSchema,
  requestPath,
  type BootstrapResponse,
  type CreateRequestInput,
  type CreateRequestResponse,
  type ErrorCode,
  type ListRequestsResponse,
  type MeResponse,
  type MetricsResponse,
  type ProblemDetails,
  type RequestDetail,
} from '@queuepilot/contracts';

/** Failure of an API call. `problem` is set when the server answered with Problem Details. */
export class ApiError extends Error {
  readonly status: number | null;
  readonly code: ErrorCode | null;
  readonly problem: ProblemDetails | null;
  readonly kind: 'problem' | 'network' | 'unexpected';

  constructor(kind: ApiError['kind'], status: number | null, problem: ProblemDetails | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.problem = problem;
    this.code = problem?.code ?? null;
  }

  get correlationId(): string | null {
    return this.problem?.correlationId ?? null;
  }

  get retryAfterSeconds(): number | null {
    return this.problem?.retryAfterSeconds ?? null;
  }
}

export interface CreateRequestResult extends CreateRequestResponse {
  /** True when the server returned an earlier request for the same idempotency key. */
  replayed: boolean;
}

export interface ListParams {
  scope?: 'mine' | 'tenant';
  limit?: number;
  cursor?: string | null;
}

/** The surface the UI depends on. The dev mock implements the same interface. */
export interface ApiClient {
  me(): Promise<MeResponse>;
  bootstrap(): Promise<BootstrapResponse>;
  createRequest(body: CreateRequestInput, idempotencyKey: string): Promise<CreateRequestResult>;
  listRequests(params?: ListParams): Promise<ListRequestsResponse>;
  getRequest(requestId: string): Promise<RequestDetail>;
  getMetrics(): Promise<MetricsResponse>;
}

export interface ApiClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /** Called when the server answers 401, so the app can end the session. */
  onUnauthenticated?: () => void;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ data: z.output<S>; headers: Headers }> {
    let token: string;
    try {
      token = await options.getToken();
    } catch {
      options.onUnauthenticated?.();
      throw new ApiError('problem', 401, null, 'No ID token available');
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...init.headers,
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await doFetch(`${options.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      });
    } catch {
      throw new ApiError('network', null, null, 'Network error');
    }

    const raw: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const problem = ProblemDetailsSchema.safeParse(raw);
      if (problem.success) {
        if (res.status === 401) options.onUnauthenticated?.();
        throw new ApiError('problem', res.status, problem.data, problem.data.title);
      }
      if (res.status === 401) options.onUnauthenticated?.();
      throw new ApiError('unexpected', res.status, null, `HTTP ${res.status}`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ApiError('unexpected', res.status, null, 'Response does not match the contract');
    return { data: parsed.data as z.output<S>, headers: res.headers };
  }

  return {
    async me() {
      return (await call(API_PATHS.me, MeResponseSchema)).data;
    },
    async bootstrap() {
      return (await call(API_PATHS.bootstrap, BootstrapResponseSchema, { method: 'POST' })).data;
    },
    async createRequest(body, idempotencyKey) {
      const { data, headers } = await call(API_PATHS.requests, CreateRequestResponseSchema, {
        method: 'POST',
        body,
        headers: { [HEADERS.idempotencyKey]: idempotencyKey },
      });
      return { ...data, replayed: headers.get(HEADERS.idempotentReplayed) === IDEMPOTENT_REPLAYED_VALUE };
    },
    async listRequests(params = {}) {
      const query = new URLSearchParams();
      if (params.scope) query.set('scope', params.scope);
      if (params.limit) query.set('limit', String(params.limit));
      if (params.cursor) query.set('cursor', params.cursor);
      const qs = query.toString();
      return (await call(`${API_PATHS.requests}${qs ? `?${qs}` : ''}`, ListRequestsResponseSchema)).data;
    },
    async getRequest(requestId) {
      return (await call(requestPath(encodeURIComponent(requestId)), RequestDetailSchema)).data;
    },
    async getMetrics() {
      return (await call(API_PATHS.metrics, MetricsResponseSchema)).data;
    },
  };
}
