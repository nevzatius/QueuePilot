/**
 * Milliseconds since the Unix epoch (UTC). Domain functions take the current time as an argument and
 * never read a clock themselves, so every decision is reproducible from its inputs.
 */
export type EpochMs = number;

/** Time source injected by adapters. Tests use a fake implementation. */
export interface Clock {
  now(): EpochMs;
}

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
