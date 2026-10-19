/* global fetch, URLSearchParams */
// Local E2E driver: real built API + real built worker (separate processes) + Auth/Firestore emulators.
// Run after both servers are up. Prints a PASS/FAIL line per check; exit code 1 on any failure.
import { randomUUID } from 'node:crypto';

const API = process.env.E2E_API ?? 'http://127.0.0.1:18182';
const WORKER = process.env.E2E_WORKER ?? 'http://127.0.0.1:18281';
const AUTH = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FS = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const docs = `http://${FS}/v1/projects/demo-queuepilot/databases/(default)/documents`;
const owner = { authorization: 'Bearer owner', 'content-type': 'application/json' };
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const num = (v) => Number(v?.integerValue ?? 0);
const fsDoc = async (path) => (await fetch(`${docs}/${path}`, { headers: owner })).json();
const val = (f) => f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? f?.timestampValue ?? f?.mapValue;

async function signIn(sub = randomUUID()) {
  const res = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-key`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', returnSecureToken: true,
      postBody: new URLSearchParams({ providerId: 'google.com', id_token: JSON.stringify({ sub, email: `${sub}@example.test`, email_verified: true }) }).toString() }),
  });
  return (await res.json()).idToken;
}
const api = (token) => async (method, path, body, headers = {}) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }), ...headers },
    ...(body && { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
};

// Seed tenant (same shape as the smoke test).
const limit = { integerValue: '10000' };
const put = await fetch(`${docs}/tenants/sandbox`, { method: 'PATCH', headers: owner, body: JSON.stringify({ fields: {
  name: { stringValue: 'Sandbox' }, status: { stringValue: 'active' }, openSignup: { booleanValue: true }, quotaMode: { stringValue: 'none' },
  schemaVersion: { integerValue: '1' },
  limits: { mapValue: { fields: { submitPerMin: limit, submitPerDayUser: { integerValue: '30' }, submitPerDayTenant: { integerValue: '2000' } } } } } }) });
check('seed tenant', put.status === 200);

const tokenA = await signIn();
const a = api(tokenA);

// Negative: unauthenticated / garbage token.
check('401 without token', (await fetch(`${API}/api/v1/me`)).status === 401);
check('401 with invalid token', (await api('garbage')('GET', '/api/v1/me')).status === 401);
// Negative: valid identity but no membership.
const noMember = await a('POST', '/api/v1/requests', { type: 'general', title: 'x', description: 'synthetic' }, { 'idempotency-key': randomUUID() });
check('no membership => request rejected (403/409-class problem)', noMember.status >= 400 && noMember.status < 500, `status=${noMember.status} code=${noMember.json?.code ?? noMember.json?.type}`);

const boot = await a('POST', '/api/v1/session/bootstrap');
check('bootstrap yields member', boot.status < 300 && boot.json?.membership?.role === 'member', `status=${boot.status}`);

// Create + replay + conflict.
const key = randomUUID();
const body = { type: 'general', title: 'E2E request', description: 'synthetic e2e' };
const created = await a('POST', '/api/v1/requests', body, { 'idempotency-key': key });
check('create => 202/201 accepted', created.status === 202 || created.status === 201, `status=${created.status}`);
const id = created.json?.requestId;
const replay = await a('POST', '/api/v1/requests', body, { 'idempotency-key': key });
check('idempotent replay returns same requestId', replay.json?.requestId === id && replay.headers.get('idempotent-replayed') !== null, `status=${replay.status}`);
const conflict = await a('POST', '/api/v1/requests', { ...body, title: 'Changed' }, { 'idempotency-key': key });
check('same key + changed payload => 409', conflict.status === 409);

// Wait for the worker to process via the local queue pump.
let detail; const t0 = Date.now();
for (;;) {
  detail = await a('GET', `/api/v1/requests/${id}`);
  if (detail.json?.status === 'COMPLETED' || detail.json?.status === 'FAILED' || Date.now() - t0 > 30_000) break;
  await new Promise((r) => setTimeout(r, 250));
}
check('request reaches COMPLETED', detail.json?.status === 'COMPLETED', `status=${detail.json?.status} after ${Date.now() - t0} ms`);
check('detail carries triage result', Boolean(detail.json?.result), JSON.stringify(detail.json?.result ?? null).slice(0, 120));

// Firestore truth: attempts, events, lease cleared.
const raw = await fsDoc(`requests/${id}`);
const f = raw.fields ?? {};
const proc = f.processing?.mapValue?.fields ?? {};
check('Firestore status COMPLETED', val(f.status) === 'COMPLETED');
check('processing.attempts == 1', num(proc.attempts) === 1, `attempts=${num(proc.attempts)}`);
const events = (await fsDoc(`requests/${id}/events`)).documents ?? [];
check('event timeline recorded (>=3 events)', events.length >= 3, `events=${events.length}`);

// Duplicate delivery of the same wake-up: must not reprocess / corrupt.
const payload = { requestId: id, tenantId: val(f.tenantId), seq: num(f.dispatch?.mapValue?.fields?.seq), correlationId: val(f.correlationId) };
const dup = await fetch(`${WORKER}/internal/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
check('duplicate delivery acknowledged 2xx', dup.status >= 200 && dup.status < 300, `status=${dup.status}`);
const after = (await fsDoc(`requests/${id}`)).fields ?? {};
const procAfter = after.processing?.mapValue?.fields ?? {};
check('duplicate leaves status COMPLETED, attempts==1', val(after.status) === 'COMPLETED' && num(procAfter.attempts) === 1, `dupCount=${num(procAfter.duplicateDeliveries)}`);
check('result unchanged by duplicate', JSON.stringify(after.result) === JSON.stringify(f.result));

// Worker negatives.
const badPayload = await fetch(`${WORKER}/internal/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'nope' }) });
check('worker rejects invalid payload (4xx)', badPayload.status >= 400 && badPayload.status < 500, `status=${badPayload.status}`);
const cross = await fetch(`${WORKER}/internal/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, tenantId: 'other-tenant' }) });
const afterCross = (await fsDoc(`requests/${id}`)).fields ?? {};
check('cross-tenant delivery cannot touch the request', val(afterCross.status) === 'COMPLETED' && num(afterCross.processing?.mapValue?.fields?.duplicateDeliveries) === num(procAfter.duplicateDeliveries), `status=${cross.status}`);

// Cross-tenant / cross-user read isolation via API: second user in same tenant must get 404.
const tokenB = await signIn();
const b = api(tokenB);
await b('POST', '/api/v1/session/bootstrap');
const foreign = await b('GET', `/api/v1/requests/${id}`);
check("another user's request => 404", foreign.status === 404, `status=${foreign.status}`);

// List + metrics.
const list = await a('GET', '/api/v1/requests?limit=5');
check('list contains the request', (list.json?.items ?? []).some((r) => r.requestId === id));
const metrics = await a('GET', '/api/v1/metrics');
check('metrics reachable', metrics.status === 200, JSON.stringify(metrics.json).slice(0, 160));

// Redis outage policy (ADR-009): REDIS_URL points at a dead port. Enforced tenant => fail closed.
const setMode = (mode) => fetch(`${docs}/tenants/sandbox?updateMask.fieldPaths=quotaMode`, { method: 'PATCH', headers: owner,
  body: JSON.stringify({ fields: { quotaMode: { stringValue: mode } } }) });
await setMode('enforced');
const tokenC = await signIn();
const c = api(tokenC);
await c('POST', '/api/v1/session/bootstrap');
const closed = await c('POST', '/api/v1/requests', body, { 'idempotency-key': randomUUID() });
const ra = closed.headers.get('retry-after');
check('enforced tenant + Redis down => 503 QUOTA_UNAVAILABLE', closed.status === 503 && closed.json?.code === 'QUOTA_UNAVAILABLE', `status=${closed.status} code=${closed.json?.code}`);
check('Retry-After header equals body retryAfterSeconds', ra !== null && Number(ra) === closed.json?.retryAfterSeconds, `header=${ra} body=${closed.json?.retryAfterSeconds}`);
const listC = await c('GET', '/api/v1/requests?limit=5');
check('nothing was persisted by the rejected submission', (listC.json?.items ?? []).length === 0);
// A replay of an already accepted request must not need Redis.
const replayDown = await a('POST', '/api/v1/requests', body, { 'idempotency-key': key });
check('idempotent replay still works while Redis is down', replayDown.status < 300 && replayDown.json?.requestId === id, `status=${replayDown.status}`);
await setMode('none');

console.log(failed === 0 ? '\nE2E: ALL PASS' : `\nE2E: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
