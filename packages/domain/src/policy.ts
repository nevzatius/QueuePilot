import { HOUR_MS, MINUTE_MS, SECOND_MS } from './time.js';

/** Business-logic starts per retry budget (I5). Counted in Firestore, never from queue headers. */
export const MAX_ATTEMPTS = 5;
/** Dispatch generations (`dispatch.seq` values) per retry budget. */
export const MAX_DISPATCH = 3;
export const LEASE_MS = 60 * SECOND_MS;
/** Upper bound for one triage run. The worker aborts processing after this. */
export const PROCESSING_TIMEOUT_MS = 20 * SECOND_MS;

/** Watchdog set at acceptance (S1) and after an admin retry (S12). */
export const INITIAL_WATCHDOG_MS = 60 * SECOND_MS;
/** Grace after lease expiry before the reconciler looks at a PROCESSING request (S2, step 2). */
export const LEASE_GRACE_MS = 30 * SECOND_MS;
/** Watchdog after a transient error (S5) and after a successful enqueue. */
export const RETRY_WATCHDOG_MS = 5 * MINUTE_MS;
/** Watchdog after an inconclusive probe (ADR-011), a failed createTask, or while a createTask is claimed. */
export const SHORT_RECHECK_MS = 1 * MINUTE_MS;
/** Cap for the step-4 backoff `min(2^checks min, 15 min)`. */
export const PROBE_BACKOFF_CAP_MS = 15 * MINUTE_MS;

export const IDEMPOTENCY_WINDOW_MS = 24 * HOUR_MS;
/** `stuck = count(watchdogAt < now - 15m)` (ARCHITECTURE §7, liveness). */
export const STUCK_AFTER_MS = 15 * MINUTE_MS;
export const RECONCILER_SHARDS = 4;
