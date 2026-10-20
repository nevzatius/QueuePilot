/* global fetch, URLSearchParams, performance, setTimeout, AbortSignal */
// Shared helpers for the local load suite: process control, auth, stats. Local emulators only.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const PORTS = { api: 18182, worker: 18281, firestore: 8080, auth: 9099 };
export const AUTH = `127.0.0.1:${PORTS.auth}`;
export const FS = `127.0.0.1:${PORTS.firestore}`;
export const API = `http://127.0.0.1:${PORTS.api}`;
export const WORKER = `http://127.0.0.1:${PORTS.worker}`;
export const DOCS = `http://${FS}/v1/projects/demo-queuepilot/databases/(default)/documents`;
export const OWNER = { authorization: 'Bearer owner', 'content-type': 'application/json' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
}
export const summarize = (v) => ({ n: v.length, p50: pct(v, 0.5), p95: pct(v, 0.95), p99: pct(v, 0.99), max: v.length ? Math.round(Math.max(...v) * 10) / 10 : null });

export function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}
export async function waitFor(url, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); await r.body?.cancel(); return; } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${url}`);
    await sleep(300);
  }
}
export async function startEmulators() {
  const child = spawn(process.execPath, ['node_modules/firebase-tools/lib/bin/firebase.js', 'emulators:start', '--project', 'demo-queuepilot', '--only', 'auth,firestore'],
    { stdio: 'ignore', env: { ...process.env, DEBUG: '', GCLOUD_PROJECT: 'demo-queuepilot' } });
  await waitFor(`http://${FS}/`); await waitFor(`http://${AUTH}/`);
  return child;
}
const baseEnv = () => ({ ...process.env, QP_ENV: 'test', GCLOUD_PROJECT: 'demo-queuepilot', FIRESTORE_EMULATOR_HOST: FS, FIREBASE_AUTH_EMULATOR_HOST: AUTH,
  QP_WORKER_URL: WORKER, QP_QUEUE_ADAPTER: 'local' });
/** Start worker + API. `env` is the explicit per-variant API configuration (recorded in the results). */
export async function startServices(env = {}) {
  const worker = spawn(process.execPath, ['dist/server.js'], { cwd: 'apps/worker', stdio: 'ignore', env: { ...baseEnv(), PORT: String(PORTS.worker), QP_WORKER_AUTH_MODE: 'local' } });
  const api = spawn(process.execPath, ['dist/server.js'], { cwd: 'apps/api', stdio: 'ignore', env: { ...baseEnv(), PORT: String(PORTS.api), ...env } });
  await waitFor(`${WORKER}/health`); await waitFor(`${API}/health`).catch(() => waitFor(`${API}/`));
  return { stop: () => { kill(api); kill(worker); } };
}
/** Wipe Firestore and re-seed the sandbox tenant so each repetition starts from the same state. */
export async function resetData() {
  await fetch(`http://${FS}/emulator/v1/projects/demo-queuepilot/databases/(default)/documents`, { method: 'DELETE' });
  const limit = { integerValue: '1000000' };
  const res = await fetch(`${DOCS}/tenants/sandbox`, { method: 'PATCH', headers: OWNER, body: JSON.stringify({ fields: {
    name: { stringValue: 'Sandbox' }, status: { stringValue: 'active' }, openSignup: { booleanValue: true }, quotaMode: { stringValue: 'none' },
    schemaVersion: { integerValue: '1' },
    limits: { mapValue: { fields: { submitPerMin: limit, submitPerDayUser: limit, submitPerDayTenant: limit } } } } }) });
  if (res.status !== 200) throw new Error(`tenant seed failed ${res.status}`);
}
export async function signIn() {
  const sub = randomUUID();
  const res = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', returnSecureToken: true, postBody: new URLSearchParams({ providerId: 'google.com', id_token: JSON.stringify({ sub, email: `${sub}@example.test`, email_verified: true }) }).toString() }) });
  const token = (await res.json()).idToken;
  const boot = await fetch(`${API}/api/v1/session/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  await boot.body?.cancel();
  return token;
}
export const signInMany = (n) => Promise.all(Array.from({ length: n }, signIn));

/** One create call, classified. Never throws. */
async function create(token, label) {
  const s = performance.now();
  try {
    const r = await fetch(`${API}/api/v1/requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ type: 'general', title: `load ${label}`, description: 'synthetic load' }), signal: AbortSignal.timeout(30_000) });
    const ms = performance.now() - s;
    if (r.status === 202) { const j = await r.json(); return { ms, status: 202, id: j.requestId, token, at: Date.now() }; }
    let code = 'UNKNOWN'; try { code = (await r.json()).code ?? 'UNKNOWN'; } catch { /* non-JSON body */ }
    return { ms, status: r.status, code };
  } catch (e) { return { ms: performance.now() - s, status: 'ERR', code: e?.name ?? 'ERR' }; }
}

/** Open-loop arrival at `rps` for `seconds` (requests scheduled by wall clock, not by completions). */
export async function openLoop({ rps, seconds, tokens, label, onAccept }) {
  const total = Math.round(rps * seconds); const t0 = Date.now(); const jobs = []; let sent = 0;
  while (sent < total) {
    const due = Math.min(total, Math.floor(((Date.now() - t0) / 1000) * rps) + 1);
    while (sent < due) { jobs.push(create(tokens[sent % tokens.length], label).then((r) => { if (r.status === 202) onAccept?.(r); return r; })); sent++; }
    await sleep(5);
  }
  const results = await Promise.all(jobs);
  const wallS = (Date.now() - t0) / 1000;
  const rejected = {};
  for (const r of results) if (r.status !== 202) { const k = `${r.status} ${r.code}`; rejected[k] = (rejected[k] ?? 0) + 1; }
  const accepted = results.filter((r) => r.status === 202);
  return { target: { rps, seconds, label }, sent, wallS: Math.round(wallS * 100) / 100, acceptedCount: accepted.length, rejected,
    acceptedPerSec: Math.round((accepted.length / wallS) * 10) / 10, httpLatencyMsAll: summarize(results.map((r) => r.ms)),
    httpLatencyMsAccepted: summarize(accepted.map((r) => r.ms)), accepted, startedAt: t0, endedAt: Date.now() };
}

export async function statusOf(a) {
  try {
    const r = await fetch(`${API}/api/v1/requests/${a.id}`, { headers: { authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(15_000) });
    return (await r.json()).status;
  } catch { return 'ERR'; }
}
/** Poll outstanding accepted requests until terminal; records accepted->observed-terminal latency (resolution = poll interval). */
export async function track(accepted, { timeoutMs = 120_000, pollMs = 500, onSample } = {}) {
  const t0 = Date.now(); let pending = accepted.slice(); const done = []; let failed = 0;
  while (pending.length && Date.now() - t0 < timeoutMs) {
    const next = [];
    for (let i = 0; i < pending.length; i += 60) {
      await Promise.all(pending.slice(i, i + 60).map(async (a) => {
        const st = await statusOf(a);
        if (st === 'COMPLETED') done.push(Date.now() - a.at); else if (st === 'FAILED') failed++; else next.push(a);
      }));
    }
    pending = next; onSample?.({ t: Date.now(), outstanding: pending.length });
    if (pending.length) await sleep(pollMs);
  }
  return { accepted: accepted.length, completed: done.length, failed, stillPending: pending.length, acceptToCompletedMs: summarize(done), drainWallS: Math.round((Date.now() - t0) / 100) / 10 };
}
