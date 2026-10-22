/* global fetch, AbortSignal */
// Shared pieces of the QStash schedule scripts (qstash-setup, qstash-shutdown). Pure and offline except
// QStashRest, which takes its fetch implementation and token explicitly. The token is read from the
// environment by the caller, travels only in the Authorization header and is never part of any message:
// response bodies are not echoed either, because an error body may repeat a credential.

import { EXIT, ScriptError } from './ops.mjs';

/** Mirrors WORKER_RECONCILE_PATH in packages/core (a test keeps the two in step). */
export const RECONCILE_PATH = '/internal/reconcile';
/** Every 60 minutes, UTC (ADR-019). QStash cron has five fields. */
export const RECONCILE_CRON = '0 * * * *';
export const DEFAULT_QSTASH_URL = 'https://qstash.upstash.io';
/** Mirror the B9-1 limits in packages/core/src/config.ts (QP_QSTASH_RETRIES 0-3, QP_QSTASH_TIMEOUT 60 s - 15 min); a test keeps them in step. */
export const DEFAULT_RETRIES = 2;
export const MAX_RETRIES = 3;
export const DEFAULT_TIMEOUT = '90s';
export const TIMEOUT_MIN_MS = 60_000;
export const TIMEOUT_MAX_MS = 15 * 60_000;

const GO_DURATION = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/;
const UNIT_MS = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
export const durationMs = (value) => [...value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)].reduce((sum, [, amount, unit]) => sum + Number(amount) * UNIT_MS[unit], 0);
/** A Go duration WITH a unit inside the validated range, as `Upstash-Timeout` requires (a bare number is answered with 400). */
export const isTimeout = (value) => GO_DURATION.test(value) && durationMs(value) >= TIMEOUT_MIN_MS && durationMs(value) <= TIMEOUT_MAX_MS;

/** An https origin with no credentials, path, query or fragment. */
const isHttpsOrigin = (value) => URL.canParse(value) && new URL(value).protocol === 'https:' && new URL(value).origin === value;
const isLocalHost = (hostname) => hostname === 'localhost' || hostname.endsWith('.localhost') || /^[\d.]+$/.test(hostname) || hostname.startsWith('[') || !hostname.includes('.');
const TOKEN = /^[\x21-\x7e]{8,}$/; // printable ASCII, no whitespace: it becomes a header value

/**
 * Read the shared settings. `QP_WORKER_URL` has NO default here: the application default is a localhost
 * address, and a schedule pointing at it would be created silently and never fire.
 */
export function resolveSettings({ env, values }) {
  const worker = env.QP_WORKER_URL;
  if (!worker || !isHttpsOrigin(worker) || isLocalHost(new URL(worker).hostname)) {
    throw new ScriptError(EXIT.USAGE, 'QP_WORKER_URL must be set to the worker public https origin (no path, no localhost)');
  }
  const baseUrl = env.QSTASH_URL || DEFAULT_QSTASH_URL;
  if (!isHttpsOrigin(baseUrl)) throw new ScriptError(EXIT.USAGE, 'QSTASH_URL must be an https origin');
  const retries = values.retries ?? String(DEFAULT_RETRIES);
  if (!/^\d$/.test(retries) || Number(retries) > MAX_RETRIES) throw new ScriptError(EXIT.USAGE, `--retries must be 0 to ${MAX_RETRIES}`);
  const timeout = values.timeout ?? DEFAULT_TIMEOUT;
  if (!isTimeout(timeout)) throw new ScriptError(EXIT.USAGE, '--timeout must be a Go duration with a unit (for example 90s) between 60s and 15m');
  return { baseUrl, destination: `${worker}${RECONCILE_PATH}`, cron: RECONCILE_CRON, retries: Number(retries), timeout };
}

/** The token, from the environment only. Never named in an error beyond the variable name. */
export function readToken(env) {
  const token = env.QSTASH_TOKEN;
  if (token === undefined || token.trim() === '') return undefined;
  if (!TOKEN.test(token)) throw new ScriptError(EXIT.USAGE, 'QSTASH_TOKEN has an unusable shape (whitespace or non-printable characters); re-copy it');
  return token;
}

/** The approval must repeat the destination exactly. A mismatch is refused even in a dry run. */
export function checkApproval({ apply, approved, destination }) {
  if (approved !== undefined && approved !== destination) throw new ScriptError(EXIT.REFUSED, '--approve-destination does not match the destination; refusing');
  if (apply && approved !== destination) throw new ScriptError(EXIT.REFUSED, 'Writes need --approve-destination=<destination> (exact match, shown by the dry run)');
}

function failure(status, response) {
  if (status === 401 || status === 403) return new ScriptError(EXIT.IO, `QStash rejected the credentials (HTTP ${status}); check QSTASH_TOKEN and that QSTASH_URL is the region of the token`);
  if (status === 429) {
    const after = response.headers?.get?.('retry-after') ?? '';
    return new ScriptError(EXIT.IO, `QStash rate limit reached (HTTP 429)${/^\d{1,6}$/.test(after) ? `; retry after ${after} s` : ''}`);
  }
  if (status >= 500) return new ScriptError(EXIT.IO, `QStash server error (HTTP ${status}); no state is assumed, rerun later`);
  return new ScriptError(EXIT.IO, `QStash request failed (HTTP ${status})`);
}

export class QStashRest {
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async call(method, path, headers = {}) {
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${this.token}`, ...headers }, signal: AbortSignal.timeout(30_000) });
    } catch { throw new ScriptError(EXIT.IO, 'QStash request failed: network error'); }
    const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
    return { status: response.status, body, response };
  }

  async list() {
    const { status, body, response } = await this.call('GET', '/v2/schedules');
    if (status !== 200) throw failure(status, response);
    if (!Array.isArray(body)) throw new ScriptError(EXIT.IO, 'QStash returned an unexpected schedule listing; nothing was changed');
    return body.filter((entry) => entry && typeof entry === 'object');
  }

  /** Creates, or with `scheduleId` updates in place (QStash upserts on `Upstash-Schedule-Id`). Returns the schedule id. */
  async upsert(settings, scheduleId) {
    const { status, body, response } = await this.call('POST', `/v2/schedules/${settings.destination}`, {
      'upstash-cron': settings.cron, 'upstash-method': 'POST', 'upstash-retries': String(settings.retries), 'upstash-timeout': settings.timeout,
      ...(scheduleId ? { 'upstash-schedule-id': scheduleId } : {}),
    });
    if (status !== 200 && status !== 201) throw failure(status, response);
    return typeof body.scheduleId === 'string' ? body.scheduleId : scheduleId;
  }

  /** True when deleted, false when it was already gone. */
  async remove(scheduleId) {
    const { status, response } = await this.call('DELETE', `/v2/schedules/${encodeURIComponent(scheduleId)}`);
    if (status === 404) return false;
    if (status !== 200 && status !== 204) throw failure(status, response);
    return true;
  }
}

export const forDestination = (schedules, destination) => schedules.filter((entry) => entry.destination === destination);
const idOf = (entry) => (typeof entry.scheduleId === 'string' ? entry.scheduleId : '(no id)');
export const describeIds = (matches) => matches.map(idOf).join(', ');

/** The timeout the listing shows for a schedule, in ms, or undefined when the listing does not expose one. */
function listedTimeoutMs(entry) {
  const header = Object.entries(entry.header ?? entry.headers ?? {}).find(([name]) => name.toLowerCase() === 'upstash-timeout')?.[1];
  const value = entry.timeout ?? (Array.isArray(header) ? header[0] : header);
  if (typeof value === 'number') return value * 1000;
  return typeof value === 'string' && GO_DURATION.test(value) ? durationMs(value) : undefined;
}

/** Whether a listed schedule already has the wanted settings. A field the listing omits counts as different, so the safe upsert runs. */
export function isCurrent(entry, wanted) {
  const timeout = listedTimeoutMs(entry);
  return entry.cron === wanted.cron && entry.retries === wanted.retries && entry.method === 'POST' && entry.isPaused !== true
    && (timeout === undefined || timeout === durationMs(wanted.timeout));
}
