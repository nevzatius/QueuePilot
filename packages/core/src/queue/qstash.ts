import { TaskPayloadSchema } from '@queuepilot/contracts';
import type { TaskPayload } from '@queuepilot/contracts';
import { taskName } from '@queuepilot/domain';
import type { Clock, TaskProbe } from '@queuepilot/domain';
import type { Logger } from 'pino';
import { isHttpsOrigin, isQStashTimeout } from '../config.js';
import type { DispatchQueue } from '../queue.js';

/**
 * Timeout of the publish call to QStash itself. It is unrelated to `Upstash-Timeout`, which is how long
 * QStash waits for the worker once it delivers. The caller's enqueue budget is 2 s (`enqueueAccepted`);
 * this one is lower so that the adapter's own transient DEADLINE_EXCEEDED classification (and log line)
 * fires first, instead of the caller aborting with a bare CANCELLED.
 */
export const QSTASH_PUBLISH_TIMEOUT_MS = 1500;
/** Longest Retry-After we pass on. QStash daily-quota resets can quote hours; the reconciler cadence is minutes. */
const MAX_RETRY_AFTER_SECONDS = 86_400;
const MAX_BODY_CHARS = 4096;

export type QStashQueueConfig = {
  token: string; baseUrl: string; workerUrl: string; retries: number; timeout: string;
  /** Overrides QSTASH_PUBLISH_TIMEOUT_MS (tests). */
  publishTimeoutMs?: number;
};
/** The slice of Response the adapter reads; the global fetch satisfies it. */
export interface QStashResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /** Present on a real Response; used to drop an unread error body. */
  body?: { cancel(): Promise<void> } | null;
}
export type QStashFetch = (url: string, init: {
  method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'manual';
}) => Promise<QStashResponse>;

/**
 * - `permanent`: retrying the same call cannot succeed (bad request, bad token, wrong region/URL).
 * - `quota`: QStash refused for rate or daily-message quota; `retryAfterSeconds` is its hint.
 * - `transient`: network, timeout, 5xx or an unreadable answer.
 */
export type QueueFailureClass = 'permanent' | 'quota' | 'transient';
/**
 * Same `ENQUEUE_FAILED:<CODE>` message as the Cloud Tasks adapter, with gRPC-style codes (the names the
 * Cloud REST client already uses), plus the class and Retry-After that callers cannot get from a string.
 * The message never carries a header, a body or the token.
 */
export class QueueEnqueueError extends Error {
  constructor(readonly code: string, readonly failureClass: QueueFailureClass, readonly status?: number,
    readonly retryAfterSeconds?: number) {
    super(`ENQUEUE_FAILED:${code}`);
    this.name = 'QueueEnqueueError';
  }
}
export type PublishOutcome = { outcome: 'CREATED' | 'DEDUPLICATED'; messageId?: string };

/** Retry-After as delta-seconds or an HTTP date; anything else (or a past date) is ignored. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  let seconds: number;
  if (/^\d{1,9}$/.test(text)) seconds = Number(text);
  else {
    const at = Date.parse(text);
    if (!/^[A-Za-z]{3}, /.test(text) || Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - nowMs) / 1000);
  }
  return seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : undefined;
}

function parseBody(text: string): { messageId?: string; deduplicated?: boolean } {
  try {
    const body: unknown = JSON.parse(text.slice(0, MAX_BODY_CHARS));
    if (body === null || typeof body !== 'object') return {};
    const { messageId, deduplicated } = body as Record<string, unknown>;
    return { ...(typeof messageId === 'string' && messageId !== '' && { messageId }),
      ...(deduplicated === true && { deduplicated: true }) };
  } catch { return {}; }
}

/**
 * Failure for a non-2xx status. 3xx is never followed (the token would travel with it), so a redirect means
 * a wrong QSTASH_URL. 408 is the only 4xx besides 429 that is worth retrying.
 */
export function classifyStatus(status: number, retryAfterSeconds?: number): QueueEnqueueError {
  if (status === 401) return new QueueEnqueueError('UNAUTHENTICATED', 'permanent', status);
  if (status === 403) return new QueueEnqueueError('PERMISSION_DENIED', 'permanent', status);
  if (status === 429) return new QueueEnqueueError('RESOURCE_EXHAUSTED', 'quota', status, retryAfterSeconds);
  if (status === 408) return new QueueEnqueueError('DEADLINE_EXCEEDED', 'transient', status);
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new QueueEnqueueError(status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT', 'permanent', status);
  }
  if (status >= 500) return new QueueEnqueueError('UNAVAILABLE', 'transient', status);
  return new QueueEnqueueError('INVALID_ARGUMENT', 'permanent', status);
}

export class QStashQueue implements DispatchQueue {
  private readonly publishUrl: string;
  private readonly publishTimeoutMs: number;
  constructor(private readonly config: QStashQueueConfig, private readonly log: Logger,
    private readonly clock: Clock, private readonly send: QStashFetch = (url, init) => fetch(url, init)) {
    // Never put a value in this message: the token or a credential URL may be among them.
    if (!/^[\x21-\x7e]+$/.test(config.token) // visible ASCII only: no space, newline or other header-splitting character
        || !isHttpsOrigin(config.baseUrl) || !URL.canParse(config.workerUrl) || new URL(config.workerUrl).origin !== config.workerUrl
        || !['http:', 'https:'].includes(new URL(config.workerUrl).protocol)
        || !Number.isInteger(config.retries) || config.retries < 0 || config.retries > 3
        || !isQStashTimeout(config.timeout)
        || (config.publishTimeoutMs !== undefined && !(config.publishTimeoutMs > 0))) {
      throw new Error('Invalid QStash configuration');
    }
    // The destination travels in the path, exactly as the QStash API documents it. Origin only: no secret.
    this.publishUrl = `${config.baseUrl}/v2/publish/${config.workerUrl}/internal/tasks`;
    this.publishTimeoutMs = config.publishTimeoutMs ?? QSTASH_PUBLISH_TIMEOUT_MS;
  }

  async enqueue(input: TaskPayload, signal: AbortSignal): Promise<void> {
    await this.publish(input, signal);
  }

  /** `enqueue` plus the outcome: a deduplicated publish is a success, like ALREADY_EXISTS (ADR-017, ADR-019). */
  async publish(input: TaskPayload, signal: AbortSignal): Promise<PublishOutcome> {
    const payload = TaskPayloadSchema.parse(input);
    const timeout = AbortSignal.timeout(this.publishTimeoutMs);
    try {
      signal.throwIfAborted();
      // One deadline covers the request and the body read.
      const response = await this.post(payload, AbortSignal.any([signal, timeout]));
      // A refusal is classified from the status alone; its body is never read, only released.
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        throw classifyStatus(response.status, response.status === 429 ? parseRetryAfter(response.headers.get('retry-after'), this.clock.now()) : undefined);
      }
      return this.map(response.status, await this.readBody(response, payload, AbortSignal.any([signal, timeout])));
    } catch (error) {
      const failure = error instanceof QueueEnqueueError ? error
        : new QueueEnqueueError(timeout.aborted ? 'DEADLINE_EXCEEDED' : signal.aborted ? 'CANCELLED' : 'UNAVAILABLE', 'transient');
      // Only the code and class are logged: error messages, headers and bodies can carry the token.
      this.log.error({ ...payload, code: 'ENQUEUE_FAILED', errorCode: failure.code, failureClass: failure.failureClass,
        ...(failure.status !== undefined && { status: failure.status }),
        ...(failure.retryAfterSeconds !== undefined && { retryAfterSeconds: failure.retryAfterSeconds }) }, 'Task creation failed');
      throw failure; // deliberately not chained to the original: its message or cause may carry request headers
    }
  }

  private async post(payload: TaskPayload, signal: AbortSignal): Promise<QStashResponse> {
    return this.send(this.publishUrl, {
      method: 'POST', redirect: 'manual', body: JSON.stringify(payload),
      signal,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
        // Same identity as the Cloud Tasks task name: one creator per (requestId, seq), ADR-017.
        'Upstash-Deduplication-Id': taskName(payload.requestId, payload.seq),
        'Upstash-Retries': String(this.config.retries),
        // Delivery timeout (Go duration with a unit). Not the publish-call timeout above.
        'Upstash-Timeout': this.config.timeout,
      },
    });
  }

  /** The message exists once the status is 2xx, so an unreadable body is not a failed publish. */
  private async readBody(response: QStashResponse, payload: TaskPayload, signal: AbortSignal): Promise<string> {
    try {
      return await Promise.race([response.text(), new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
      })]);
    } catch {
      this.log.warn({ ...payload, code: 'ENQUEUE_BODY_UNREADABLE', status: response.status }, 'QStash accepted the message but its answer could not be read');
      return '';
    }
  }

  private map(status: number, text: string): PublishOutcome {
    const body = parseBody(text);
    // Measured (ADR-019): a duplicate answers 201 with "deduplicated":true. Docs say 202; a 200 or 202 is not
    // assumed, so any 2xx other than 201 must prove itself with a messageId.
    if (status !== 201 && body.messageId === undefined) throw new QueueEnqueueError('UNKNOWN', 'transient', status);
    return { outcome: body.deduplicated === true ? 'DEDUPLICATED' : 'CREATED',
      ...(body.messageId !== undefined && { messageId: body.messageId }) };
  }

  /** ADR-019: no probe call. UNKNOWN places an order, which ADR-011/014/017 allow. */
  async probe(_requestId: string, seq: number): Promise<TaskProbe> {
    return { seq, result: 'UNKNOWN' };
  }
}
