import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskPayload } from '@queuepilot/contracts';
import { TaskPayloadSchema } from '@queuepilot/contracts';
import { capacityLookupDelayMs, decideCompletion, decideDelivery, PROCESSING_TIMEOUT_MS, triage } from '@queuepilot/domain';
import type { ProcessingOutcome } from '@queuepilot/domain';
import type { Logger } from 'pino';
import type { StoredRequest } from '../requests.js';
import { requestState } from './store.js';
import type { ProcessingStore } from './store.js';

export type Processor = (request: StoredRequest, requestId: string, signal: AbortSignal) => Promise<ProcessingOutcome>;
export const processTriage: Processor = async (request, requestId, signal) => {
  await delay(capacityLookupDelayMs(requestId), undefined, { signal });
  const outcome = triage(request, request.rulesVersion);
  return outcome.ok ? { kind: 'SUCCESS', result: outcome.result }
    : { kind: 'PERMANENT_ERROR', error: { code: outcome.code, message: 'Unsupported rules version' } };
};

export class WorkerService {
  constructor(private readonly store: ProcessingStore, private readonly log: Logger,
    private readonly process: Processor = processTriage) {}

  async deliver(input: TaskPayload): Promise<{ http: number; kind: string }> {
    const payload = TaskPayloadSchema.parse(input);
    const log = this.log.child({ ...payload });
    const leaseId = randomUUID();
    const acquired = await this.store.transact(payload, (request, now) => decideDelivery(requestState(request), { seq: payload.seq, leaseId }, now));
    const delivery = acquired.decision;
    if (delivery.kind === 'FUTURE_DISPATCH') log.error({ code: delivery.kind }, 'Future dispatch received');
    else log.info({ code: delivery.kind }, 'Delivery decision committed');
    if (delivery.kind !== 'ACQUIRE_LEASE') return { http: delivery.http, kind: delivery.kind };
    if (acquired.request?.dispatch.attentionSince) log.info({ code: 'ATTENTION_CLEARED' }, 'Delivery cleared attention');

    // Business logic only starts after the lease commit. Never use task headers for budgets.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: ProcessingOutcome;
    try {
      outcome = await Promise.race([
        Promise.resolve().then(() => this.process(acquired.request!, payload.requestId, controller.signal)),
        new Promise<ProcessingOutcome>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve({ kind: 'TRANSIENT_ERROR',
            error: { code: 'PROCESSING_TIMEOUT', message: 'Processing deadline exceeded' } }); }, PROCESSING_TIMEOUT_MS);
        }),
      ]);
    } catch {
      outcome = { kind: 'TRANSIENT_ERROR', error: { code: 'PROCESSING_ERROR', message: 'Processing failed' } };
    } finally { clearTimeout(timer); }
    const completed = await this.store.transact(payload, (request, now) => decideCompletion(requestState(request), leaseId, outcome, now));
    log.info({ code: completed.decision.kind, attempt: delivery.attempt }, 'Completion decision committed');
    return { http: completed.decision.http, kind: completed.decision.kind };
  }
}
