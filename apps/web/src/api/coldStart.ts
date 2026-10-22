/**
 * Free-tier cold start handling (ADR-019). A sleeping Render free service answered a direct request in 13.7 s
 * (spike, n=1; 8-14 s measured) and Render documents up to about 50 s. These numbers size the budget below; they
 * are not QueuePilot measurements.
 */

/** A call with no answer for this long shows the "waking up" notice. Above the common wake-up floor of a warm API. */
export const SLOW_RESPONSE_NOTICE_MS = 4_000;
/** One attempt is abandoned after this long (a bit over the documented 50 s), so a hung socket cannot outlast the budget. */
export const ATTEMPT_TIMEOUT_MS = 60_000;
/** No new attempt starts once this much time has passed since the call began (about the documented worst case plus margin). */
export const RETRY_BUDGET_MS = 90_000;
/** Modest exponential backoff between attempts: 2 s, 4 s, 8 s, then 10 s. */
export const RETRY_BACKOFF_START_MS = 2_000;
export const RETRY_BACKOFF_MAX_MS = 10_000;

/** Statuses a sleeping or restarting platform proxy answers with (no QueuePilot Problem Details body). */
export const PLATFORM_UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
