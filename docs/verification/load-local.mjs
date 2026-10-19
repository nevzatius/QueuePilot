/* global fetch, URLSearchParams, performance, setTimeout */
// Local open-loop load probe (NOT a benchmark): emulators + one API + one worker on one Windows laptop.
import { randomUUID } from 'node:crypto';
const API = 'http://127.0.0.1:18182';
const AUTH = '127.0.0.1:9099';
const USERS = 20;
async function signIn() {
  const sub = randomUUID();
  const res = await fetch(`http://${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=demo-key`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', returnSecureToken: true, postBody: new URLSearchParams({ providerId: 'google.com', id_token: JSON.stringify({ sub, email: `${sub}@example.test`, email_verified: true }) }).toString() }) });
  const token = (await res.json()).idToken;
  await fetch(`${API}/api/v1/session/bootstrap`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return token;
}
const tokens = await Promise.all(Array.from({ length: USERS }, signIn));
const pct = (a, p) => a.length ? a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN;

async function phase(name, rps, seconds) {
  const lat = []; const statuses = {}; const accepted = []; const t0 = Date.now(); let sent = 0; const inflight = [];
  const total = rps * seconds;
  while (sent < total) {
    const due = Math.floor((Date.now() - t0) / 1000 * rps);
    while (sent < due && sent < total) {
      const token = tokens[sent % USERS]; sent++;
      const s = performance.now();
      inflight.push(fetch(`${API}/api/v1/requests`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ type: 'general', title: `load ${name}`, description: 'synthetic load' }) })
        .then(async (r) => { lat.push(performance.now() - s); statuses[r.status] = (statuses[r.status] ?? 0) + 1;
          if (r.status === 202) accepted.push({ id: (await r.json()).requestId, token, at: Date.now() }); else await r.body?.cancel(); })
        .catch(() => { statuses.ERR = (statuses.ERR ?? 0) + 1; }));
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.all(inflight);
  const wall = (Date.now() - t0) / 1000;
  console.log(`${name}: target=${rps}/s for ${seconds}s sent=${sent} wall=${wall.toFixed(1)}s achieved=${(accepted.length / wall).toFixed(1)}/s accepted statuses=${JSON.stringify(statuses)} ` +
    `create latency ms p50=${pct(lat, .5).toFixed(0)} p95=${pct(lat, .95).toFixed(0)} p99=${pct(lat, .99).toFixed(0)}`);
  return accepted;
}
async function drain(accepted, label) {
  const t0 = Date.now(); let pending = accepted.slice(); const doneAt = new Map(); let failed = 0;
  while (pending.length && Date.now() - t0 < 90_000) {
    const next = [];
    await Promise.all(pending.map(async (a) => {
      const r = await fetch(`${API}/api/v1/requests/${a.id}`, { headers: { authorization: `Bearer ${a.token}` } });
      const j = await r.json();
      if (j.status === 'COMPLETED') doneAt.set(a.id, Date.now() - a.at); else if (j.status === 'FAILED') failed++; else next.push(a);
    }));
    pending = next; if (pending.length) await new Promise((r) => setTimeout(r, 500));
  }
  const l = [...doneAt.values()];
  console.log(`${label}: accepted=${accepted.length} completed=${doneAt.size} failed=${failed} still-pending=${pending.length} ` +
    `accept->COMPLETED ms p50=${pct(l, .5)} p95=${pct(l, .95)} p99=${pct(l, .99)} drain-wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
const a1 = await phase('baseline', 20, 15); await drain(a1, 'baseline');
const a2 = await phase('spike', 100, 8); await drain(a2, 'spike');
const a3 = await phase('recovery', 20, 10); await drain(a3, 'recovery');
