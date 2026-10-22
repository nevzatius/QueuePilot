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
import {
  ATTEMPT_TIMEOUT_MS,
  PLATFORM_UNAVAILABLE_STATUSES,
  RETRY_BACKOFF_MAX_MS,
  RETRY_BACKOFF_START_MS,
  RETRY_BUDGET_MS,
  SLOW_RESPONSE_NOTICE_MS,
} from './coldStart';

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
  /** True while any call is slow or being retried after a cold-start style failure; false when none is. */
  onWakingChange?: (waking: boolean) => void;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  // Calls that currently show the waking notice; the callback fires only when the set becomes (non-)empty.
  const waking = new Set<symbol>();
  function setWaking(id: symbol, on: boolean) {
    const before = waking.size > 0;
    if (on) waking.add(id);
    else waking.delete(id);
    const after = waking.size > 0;
    if (before !== after) options.onWakingChange?.(after);
  }

  type Attempt =
    | { kind: 'response'; res: Response; raw: unknown }
    | { kind: 'transient'; error: ApiError };

  async function attempt(url: string, init: RequestInit): Promise<Attempt> {
    // Credentials are never sent: auth is the bearer token and the API forbids credentialed CORS.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await doFetch(url, { ...init, mode: 'cors', credentials: 'omit', signal: controller.signal });
      } catch {
        return { kind: 'transient', error: new ApiError('network', null, null, 'Network error') };
      }
      const raw: unknown = await res.json().catch(() => undefined);
      // A platform proxy answers 502/503/504 with HTML while the service sleeps; an API answer is Problem Details
      // and is final (for example QUOTA_UNAVAILABLE), so it is never mistaken for a wake-up.
      if (PLATFORM_UNAVAILABLE_STATUSES.has(res.status) && !ProblemDetailsSchema.safeParse(raw).success) {
        return { kind: 'transient', error: new ApiError('unexpected', res.status, null, `HTTP ${res.status}`) };
      }
      return { kind: 'response', res, raw };
    } finally {
      clearTimeout(timer);
    }
  }

  async function call<S extends z.ZodType>(
    path: string,
    schema: S,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ data: z.output<S>; headers: Headers }> {
    const method = init.method ?? 'GET';
    // Retrying is safe for reads, and for writes only when the same Idempotency-Key is sent again, which the server
    // answers with the original result. A write without a key (bootstrap) is never retried.
    const canRetry = method === 'GET' || init.headers?.[HEADERS.idempotencyKey] !== undefined;
    const id = Symbol(path);
    const slowTimer = setTimeout(() => setWaking(id, true), SLOW_RESPONSE_NOTICE_MS);
    const started = Date.now();
    let backoff = RETRY_BACKOFF_START_MS;
    try {
      for (;;) {
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

        const outcome = await attempt(`${baseUrl}${path}`, {
          method,
          headers,
          ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        });
        if (outcome.kind === 'transient') {
          if (!canRetry || Date.now() - started + backoff > RETRY_BUDGET_MS) throw outcome.error;
          setWaking(id, true);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          backoff = Math.min(backoff * 2, RETRY_BACKOFF_MAX_MS);
          continue;
        }

        const { res, raw } = outcome;
        if (!res.ok) {
          const problem = ProblemDetailsSchema.safeParse(raw);
          if (res.status === 401) options.onUnauthenticated?.();
          if (problem.success) throw new ApiError('problem', res.status, problem.data, problem.data.title);
          throw new ApiError('unexpected', res.status, null, `HTTP ${res.status}`);
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw new ApiError('unexpected', res.status, null, 'Response does not match the contract');
        return { data: parsed.data as z.output<S>, headers: res.headers };
      }
    } finally {
      clearTimeout(slowTimer);
      setWaking(id, false);
    }
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
