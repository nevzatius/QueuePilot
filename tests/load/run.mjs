/* global fetch, performance */
// Reproducible LOCAL load suite. Emulators + one API + one worker on one machine. Not a Cloud Run / Cloud Tasks / Upstash benchmark.
// Usage: node tests/load/run.mjs [--reps 3] [--only baseline,spike,...] [--quick]
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import {
  DOCS, OWNER, WORKER, kill, openLoop, resetData, signInMany, sleep, startEmulators, startServices, statusOf, summarize, track,
} from './lib.mjs';
import { renderReport } from './report.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const QUICK = args.includes('--quick');
const REPS = Number(opt('reps', QUICK ? 1 : 3));
const ONLY = opt('only', '')?.split(',').filter(Boolean);
const scale = QUICK ? 0.4 : 1;
const secs = (n) => Math.max(3, Math.round(n * scale));

// Local queue model constants (packages/core/src/queue/local.ts defaults; the in-process queue is NOT configurable by env).
const LOCAL_QUEUE = { dispatchesPerSecond: 20, concurrency: 30, pumpIntervalMs: 100 };
const API_ADMISSION = { QP_INGEST_RPS_PER_INSTANCE: 40, QP_INGEST_MAX_INFLIGHT: 32, QP_MAX_BACKLOG: 20_000 };
const VARIANTS = {
  'redis-off': { QP_REDIS_ENABLED: 'false' },
  'redis-unreachable': { QP_REDIS_ENABLED: 'true', REDIS_URL: 'redis://127.0.0.1:6390' },
  'redis-on': { QP_REDIS_ENABLED: 'true', REDIS_URL: process.env.QP_LOAD_REDIS_URL ?? 'redis://127.0.0.1:6379' },
};
const tcpOpen = (url) => new Promise((resolve) => {
  const u = new URL(url); const s = net.connect({ host: u.hostname, port: Number(u.port || 6379) });
  s.setTimeout(1000); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); });
});

/** Samples outstanding (accepted, not yet terminal) requests once per second while load runs. */
function liveTracker() {
  const pending = new Map(); const samples = []; let running = true; const t0 = Date.now(); let completed = 0; let failed = 0;
  const loop = (async () => {
    while (running || pending.size) {
      const batch = [...pending.values()];
      for (let i = 0; i < batch.length; i += 60) {
        await Promise.all(batch.slice(i, i + 60).map(async (a) => {
          const st = await statusOf(a);
          if (st === 'COMPLETED') { completed++; a.doneMs = Date.now() - a.at; pending.delete(a.id); } else if (st === 'FAILED') { failed++; pending.delete(a.id); }
        }));
      }
      samples.push({ tS: Math.round((Date.now() - t0) / 100) / 10, outstanding: pending.size, completed });
      if (Date.now() - t0 > 240_000) break;
      await sleep(running ? 1000 : 500);
    }
  })();
  const all = [];
  return { add: (a) => { pending.set(a.id, a); all.push(a); }, stop: async () => { running = false; await loop; return { samples, completed, failed, stillPending: pending.size, all, t0 }; } };
}

async function withServices(variant, extraEnv, fn) {
  await resetData();
  const svc = await startServices({ ...VARIANTS[variant], ...extraEnv });
  try { return await fn(); } finally { svc.stop(); await sleep(500); }
}

const stripAccepted = (load) => { const copy = { ...load }; delete copy.accepted; return copy; };

const scenarios = {
  // Steady arrival below the 20/s local dispatch rate and the 40/s per-instance admission rate.
  baseline: async (variant) => withServices(variant, {}, async () => {
    const tokens = await signInMany(20);
    const load = await openLoop({ rps: 20, seconds: secs(15), tokens, label: 'baseline' });
    const done = await track(load.accepted);
    return { load: stripAccepted(load), completion: done };
  }),
  // Arrival above the 40/s admission rate: expect 503 OVERLOADED from admission control, accepted work still completes.
  spike: async (variant) => withServices(variant, {}, async () => {
    const tokens = await signInMany(20);
    const load = await openLoop({ rps: 100, seconds: secs(8), tokens, label: 'spike' });
    const done = await track(load.accepted);
    return { load: stripAccepted(load), completion: done };
  }),
  // warm-up 20/s -> spike 100/s -> 10/s tail. Backlog = accepted but not terminal, sampled every ~1 s.
  recovery: async (variant) => withServices(variant, {}, async () => {
    const tokens = await signInMany(20); const tr = liveTracker();
    const onAccept = (a) => tr.add(a);
    const warm = await openLoop({ rps: 20, seconds: secs(8), tokens, label: 'warm', onAccept });
    const spike = await openLoop({ rps: 100, seconds: secs(8), tokens, label: 'spike', onAccept });
    const spikeEnd = spike.endedAt;
    const tail = await openLoop({ rps: 10, seconds: secs(25), tokens, label: 'tail', onAccept });
    const t = await tr.stop();
    const sampleAt = (s) => t.t0 + s.tS * 1000;
    const peak = Math.max(...t.samples.map((s) => s.outstanding));
    const atEnd = t.samples.find((s) => sampleAt(s) >= spikeEnd);
    const back = t.samples.find((s) => sampleAt(s) > spikeEnd && s.outstanding <= 10);
    const doneAfter = t.all.filter((a) => a.at >= tail.startedAt && a.doneMs !== undefined).map((a) => a.doneMs);
    const doneWarm = t.all.filter((a) => a.at < spike.startedAt && a.doneMs !== undefined).map((a) => a.doneMs);
    return {
      phases: [stripAccepted(warm), stripAccepted(spike), stripAccepted(tail)],
      backlog: { peakOutstanding: peak, outstandingAtSpikeEnd: atEnd?.outstanding ?? null, backlogThreshold: 10,
        recoveryS: back ? Math.round((sampleAt(back) - spikeEnd) / 100) / 10 : null, recovered: Boolean(back), samples: t.samples },
      completion: { accepted: t.all.length, completed: t.completed, failed: t.failed, stillPending: t.stillPending,
        acceptToCompletedMs: summarize(t.all.filter((a) => a.doneMs !== undefined).map((a) => a.doneMs)),
        warmPhaseAcceptToCompletedMs: summarize(doneWarm), tailPhaseAcceptToCompletedMs: summarize(doneAfter) },
    };
  }),
  // Worker throughput WITHOUT the 20/s local queue: API enqueue is faulted (QP_FAULT_CREATE=fail), requests stay ACCEPTED,
  // and wake-ups are POSTed straight to the worker at fixed concurrency. Measures the worker + Firestore emulator, not admission.
  'worker-throughput': async (variant) => withServices(variant, { QP_FAULT_CREATE: 'fail' }, async () => {
    const tokens = await signInMany(10); const N = QUICK ? 60 : 150; const levels = [1, 8, 32]; const out = [];
    for (const concurrency of levels) {
      const load = await openLoop({ rps: 15, seconds: Math.ceil(N / 15), tokens, label: `worker-c${concurrency}` });
      const payloads = await Promise.all(load.accepted.map(async (a) => {
        const f = (await (await fetch(`${DOCS}/requests/${a.id}`, { headers: OWNER })).json()).fields;
        return { a, body: { requestId: a.id, tenantId: f.tenantId.stringValue, seq: Number(f.dispatch.mapValue.fields.seq.integerValue), correlationId: f.correlationId.stringValue } };
      }));
      const lat = []; const codes = {}; let next = 0; const t0 = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < payloads.length) {
          const p = payloads[next++]; const s = performance.now();
          const r = await fetch(`${WORKER}/internal/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p.body) });
          await r.body?.cancel(); lat.push(performance.now() - s); codes[r.status] = (codes[r.status] ?? 0) + 1;
        }
      }));
      const wallS = (performance.now() - t0) / 1000;
      let completed = 0; let failed = 0;
      for (const p of payloads) { const st = await statusOf(p.a); if (st === 'COMPLETED') completed++; else if (st === 'FAILED') failed++; }
      out.push({ concurrency, deliveries: payloads.length, ingestAcceptedForSetup: load.acceptedCount, rejectedDuringSetup: load.rejected, wallS: Math.round(wallS * 100) / 100,
        deliveriesPerSec: Math.round((payloads.length / wallS) * 10) / 10, workerStatusCodes: codes, deliveryLatencyMs: summarize(lat), completed, failed });
    }
    return { levels: out };
  }),
};

const PLAN = [
  ['redis-off', ['baseline', 'spike', 'recovery', 'worker-throughput']],
  ['redis-unreachable', ['baseline', 'spike']],
];
if (await tcpOpen(VARIANTS['redis-on'].REDIS_URL)) PLAN.push(['redis-on', ['baseline', 'spike']]);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = `tests/load/results/${stamp}`;
mkdirSync(outDir, { recursive: true });
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return null; } };
const meta = {
  startedAt: new Date().toISOString(), commit: sh('git rev-parse --short HEAD'), dirty: Boolean(sh('git status --porcelain')),
  node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 2 ** 30),
  reps: REPS, quick: QUICK, localQueue: LOCAL_QUEUE, apiAdmission: API_ADMISSION, variants: VARIANTS,
  redisOn: PLAN.some(([v]) => v === 'redis-on') ? 'RUN' : 'NOT RUN: no reachable Redis (set QP_LOAD_REDIS_URL)',
  caveat: 'Emulators + in-process LocalDispatchQueue (20 dispatches/s) on one machine. Not comparable with Cloud Run / Cloud Tasks / Upstash.',
};
const runs = [];
const emu = await startEmulators();
let exitCode = 0;
try {
  for (const [variant, names] of PLAN) {
    for (const name of names) {
      if (ONLY?.length && !ONLY.includes(name)) continue;
      for (let rep = 1; rep <= REPS; rep++) {
        const startedAt = new Date().toISOString();
        try {
          const result = await scenarios[name](variant);
          runs.push({ scenario: name, variant, rep, startedAt, ...result });
          console.log(`ok   ${variant}/${name} rep ${rep}`);
        } catch (e) { runs.push({ scenario: name, variant, rep, startedAt, error: String(e?.stack ?? e) }); console.log(`FAIL ${variant}/${name} rep ${rep}: ${e?.message}`); exitCode = 1; }
        writeFileSync(`${outDir}/raw.json`, JSON.stringify({ meta, runs }, null, 2));
      }
    }
  }
} finally { kill(emu); }
meta.finishedAt = new Date().toISOString();
writeFileSync(`${outDir}/raw.json`, JSON.stringify({ meta, runs }, null, 2));
writeFileSync(`${outDir}/REPORT.md`, renderReport(meta, runs));
console.log(`results: ${outDir}`);
process.exit(exitCode);
