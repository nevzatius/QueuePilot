// Markdown report from raw run records. Only measured values are printed; absent data is shown as "n/a" or "NOT RUN".
const med = (a) => { const v = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
const f = (x) => (x === null || x === undefined ? 'n/a' : String(x));
const range = (a) => { const v = a.filter((x) => x !== null && x !== undefined); return v.length ? `${f(med(a))} (${Math.min(...v)}–${Math.max(...v)})` : 'n/a'; };
const rejText = (r) => { const e = Object.entries(r ?? {}); return e.length ? e.map(([k, n]) => `${k}: ${n}`).join('; ') : 'none'; };
const sumRej = (reps) => { const t = {}; for (const r of reps) for (const [k, n] of Object.entries(r)) t[k] = (t[k] ?? 0) + n; return t; };

export function renderReport(meta, runs) {
  const L = [];
  L.push('# QueuePilot local load report (B6)', '');
  L.push(`Commit \`${meta.commit}\`${meta.dirty ? ' (dirty tree)' : ''} · ${meta.startedAt} · Node ${meta.node} · ${meta.os} · ${meta.cpus} CPUs (${meta.cpuModel}) · ${meta.memGB} GB · reps=${meta.reps}${meta.quick ? ' · QUICK mode (shortened)' : ''}`, '');
  L.push(`> ${meta.caveat}`, '');
  L.push('## Explicit local limits', '');
  L.push(`- Local dispatch queue (\`LocalDispatchQueue\`): **${meta.localQueue.dispatchesPerSecond} dispatches/s**, concurrency ${meta.localQueue.concurrency}, pumped every ${meta.localQueue.pumpIntervalMs} ms. Not configurable by env. It caps accepted->COMPLETED throughput in every end-to-end scenario below.`);
  L.push(`- API admission: ${meta.apiAdmission.QP_INGEST_RPS_PER_INSTANCE} req/s per instance, ${meta.apiAdmission.QP_INGEST_MAX_INFLIGHT} in flight, backlog cap ${meta.apiAdmission.QP_MAX_BACKLOG}. Excess is rejected \`503 OVERLOADED\`.`);
  L.push(`- Redis: \`redis-off\` = disabled; \`redis-unreachable\` = enabled but dead port (fail-closed/degraded path); \`redis-on\` = **${meta.redisOn}**.`, '');
  const groups = new Map();
  for (const r of runs) { const k = `${r.variant}/${r.scenario}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  L.push('## Results (median across reps, min–max in parentheses)', '');
  L.push('### API admission (HTTP create path)', '');
  L.push('| variant/scenario | sent | accepted | accepted/s | rejected (all reps) | HTTP p50 ms | p95 ms | p99 ms |', '|---|---|---|---|---|---|---|---|');
  for (const [k, reps] of groups) {
    const loads = reps.filter((r) => !r.error).flatMap((r) => (r.load ? [r.load] : r.phases ? [r.phases[1]] : []));
    if (!loads.length) continue;
    const label = reps[0].scenario === 'recovery' ? `${k} (spike phase)` : k;
    L.push(`| ${label} | ${range(loads.map((l) => l.sent))} | ${range(loads.map((l) => l.acceptedCount))} | ${range(loads.map((l) => l.acceptedPerSec))} | ${rejText(sumRej(loads.map((l) => l.rejected)))} | ${range(loads.map((l) => l.httpLatencyMsAll.p50))} | ${range(loads.map((l) => l.httpLatencyMsAll.p95))} | ${range(loads.map((l) => l.httpLatencyMsAll.p99))} |`);
  }
  L.push('', 'HTTP latency covers all responses (accepted and rejected) measured by the load client on the same machine.', '');
  L.push('### Completion (queue + worker, end to end)', '');
  L.push('| variant/scenario | accepted | completed | failed | still pending | accept→COMPLETED p50 ms | p95 ms | p99 ms | drain wall s |', '|---|---|---|---|---|---|---|---|---|');
  for (const [k, reps] of groups) {
    const cs = reps.filter((r) => !r.error && r.completion).map((r) => r.completion);
    if (!cs.length) continue;
    L.push(`| ${k} | ${range(cs.map((c) => c.accepted))} | ${range(cs.map((c) => c.completed))} | ${range(cs.map((c) => c.failed))} | ${range(cs.map((c) => c.stillPending))} | ${range(cs.map((c) => c.acceptToCompletedMs.p50))} | ${range(cs.map((c) => c.acceptToCompletedMs.p95))} | ${range(cs.map((c) => c.acceptToCompletedMs.p99))} | ${range(cs.map((c) => c.drainWallS))} |`);
  }
  L.push('', 'Accept→COMPLETED is observed by polling `GET /requests/:id` every ~0.5–1 s, so its resolution is about that interval.', '');
  const rec = runs.filter((r) => r.scenario === 'recovery' && !r.error);
  if (rec.length) {
    L.push('### Backlog and recovery (warm-up → spike → low tail)', '');
    L.push('| rep | peak outstanding | outstanding at spike end | recovery to ≤10 outstanding (s after spike end) | tail accept→COMPLETED p50 / p95 ms | warm-up p50 / p95 ms |', '|---|---|---|---|---|---|');
    for (const r of rec) L.push(`| ${r.variant} #${r.rep} | ${r.backlog.peakOutstanding} | ${f(r.backlog.outstandingAtSpikeEnd)} | ${r.backlog.recovered ? r.backlog.recoveryS : 'NOT RECOVERED'} | ${f(r.completion.tailPhaseAcceptToCompletedMs.p50)} / ${f(r.completion.tailPhaseAcceptToCompletedMs.p95)} | ${f(r.completion.warmPhaseAcceptToCompletedMs.p50)} / ${f(r.completion.warmPhaseAcceptToCompletedMs.p95)} |`);
    L.push('');
  }
  const wt = runs.filter((r) => r.scenario === 'worker-throughput' && !r.error);
  if (wt.length) {
    L.push('### Worker throughput (direct delivery, bypasses the 20/s local queue and admission)', '');
    L.push('| concurrency | deliveries/s | delivery p50 ms | p95 ms | p99 ms | completed / deliveries |', '|---|---|---|---|---|---|');
    for (const c of [...new Set(wt.flatMap((r) => r.levels.map((l) => l.concurrency)))]) {
      const ls = wt.flatMap((r) => r.levels.filter((l) => l.concurrency === c));
      L.push(`| ${c} | ${range(ls.map((l) => l.deliveriesPerSec))} | ${range(ls.map((l) => l.deliveryLatencyMs.p50))} | ${range(ls.map((l) => l.deliveryLatencyMs.p95))} | ${range(ls.map((l) => l.deliveryLatencyMs.p99))} | ${ls.map((l) => `${l.completed}/${l.deliveries}`).join(', ')} |`);
    }
    L.push('', 'This measures worker handler + Firestore **emulator** transactions on one machine, not Cloud Run.', '');
  }
  const errs = runs.filter((r) => r.error);
  if (errs.length) { L.push('## Errors', ''); for (const e of errs) L.push(`- ${e.variant}/${e.scenario} rep ${e.rep}: \`${e.error.split('\n')[0]}\``); L.push(''); }
  L.push('## Not run', '', `- Redis enabled against a real Redis: ${meta.redisOn}.`, '- Cloud Run, Cloud Tasks, Upstash, real Google OAuth: never exercised (no cloud load tests by design).', '- k6: not installed here; see `tests/load/README.md` for the optional k6 plan.', '');
  return L.join('\n');
}
