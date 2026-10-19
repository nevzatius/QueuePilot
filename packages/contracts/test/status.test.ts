import { describe, expect, it } from 'vitest';
import {
  DISPLAY_STATUSES,
  REQUEST_STATUSES,
  RequestStatusSchema,
  deriveDisplayStatus,
  isTerminalStatus,
  type DisplayStatus,
  type RequestStatus,
} from '../src/index.js';

describe('status', () => {
  it('stores exactly four statuses; QUEUED and RETRYING are never stored', () => {
    expect([...REQUEST_STATUSES]).toEqual(['ACCEPTED', 'PROCESSING', 'COMPLETED', 'FAILED']);
    expect(RequestStatusSchema.safeParse('QUEUED').success).toBe(false);
    expect(RequestStatusSchema.safeParse('RETRYING').success).toBe(false);
  });

  const cases: Array<[RequestStatus, number, DisplayStatus]> = [
    ['ACCEPTED', 0, 'QUEUED'],
    ['ACCEPTED', 1, 'RETRYING'],
    ['ACCEPTED', 4, 'RETRYING'],
    ['PROCESSING', 0, 'PROCESSING'],
    ['PROCESSING', 3, 'PROCESSING'],
    ['COMPLETED', 2, 'COMPLETED'],
    ['FAILED', 5, 'FAILED'],
  ];
  it.each(cases)('deriveDisplayStatus(%s, attempts=%i) = %s', (status, attempts, expected) => {
    expect(deriveDisplayStatus(status, attempts)).toBe(expected);
    expect(DISPLAY_STATUSES).toContain(expected);
  });

  it('flags only COMPLETED and FAILED as terminal', () => {
    expect(REQUEST_STATUSES.filter(isTerminalStatus)).toEqual(['COMPLETED', 'FAILED']);
  });
});
