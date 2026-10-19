import { describe, expect, it, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { capacityLookupDelayMs, triage } from '@queuepilot/domain';
import { processTriage, StoredRequestSchema } from '@queuepilot/core';

const requestId = '098a66e5-6d29-4ef5-a9cf-0c9621e5bc4f';
const request = () => StoredRequestSchema.parse({ schemaVersion: 1, tenantId: 'test-processing', createdBy: 'synthetic',
  type: 'technical_service', title: 'Synthetic processing', description: 'Private synthetic description', priority: 'high',
  attributes: { preferredWindow: 'morning' }, status: 'ACCEPTED', processing: { attempts: 0, maxAttempts: 5, duplicateDeliveries: 0 },
  dispatch: { seq: 1, maxSeq: 3, deliveredSeq: 0, checks: 0 }, watchdogAt: Timestamp.fromMillis(1000), watchdogShard: 0,
  rulesVersion: 'triage-v1', createdAt: Timestamp.fromMillis(0), updatedAt: Timestamp.fromMillis(0), correlationId: 'synthetic', source: 'api' });

describe('versioned worker processing', () => {
  it('waits for seeded capacity lookup then returns the domain triage result, repeatably', async () => {
    vi.useFakeTimers();
    try {
      const stored = request(); const delay = capacityLookupDelayMs(requestId);
      expect(delay).toBeGreaterThanOrEqual(200); expect(delay).toBeLessThanOrEqual(800);
      let finished = false;
      const pending = processTriage(stored, requestId, new AbortController().signal).then((value) => { finished = true; return value; });
      await vi.advanceTimersByTimeAsync(delay - 1); expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await pending; const expected = triage(stored, stored.rulesVersion);
      expect(expected.ok).toBe(true);
      if (expected.ok) expect(outcome).toEqual({ kind: 'SUCCESS', result: expected.result });
      const retry = processTriage(stored, requestId, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(delay); expect(await retry).toEqual(outcome);
    } finally { vi.useRealTimers(); }
  });
  it('unknown pinned rules version is permanent and cancellation stops the lookup', async () => {
    vi.useFakeTimers();
    try {
      const stored = { ...request(), rulesVersion: 'not-published' };
      const pending = processTriage(stored, requestId, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(800);
      expect(await pending).toMatchObject({ kind: 'PERMANENT_ERROR', error: { code: 'UNKNOWN_RULES_VERSION' } });
      const controller = new AbortController();
      const aborted = expect(processTriage(request(), requestId, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort(); await aborted;
    } finally { vi.useRealTimers(); }
  });
});
