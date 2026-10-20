// Correctness gate over a raw.json result (B6 accept): no lost work, no failures, every accepted request completed, no unexplained rejections.
// Usage: node tests/load/check.mjs tests/load/results/<run>/raw.json   (exit 1 on any violation). Latency is reported, never gated.
import { readFileSync } from 'node:fs';
import process from 'node:process';

const { runs } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const bad = [];
const expect = (ok, run, what) => { if (!ok) bad.push(`${run.variant}/${run.scenario}#${run.rep}: ${what}`); };
for (const run of runs) {
  expect(!run.error, run, `run errored: ${run.error?.split('\n')[0]}`);
  if (run.error) continue;
  const c = run.completion;
  if (c) {
    expect(c.completed === c.accepted, run, `completed ${c.completed} != accepted ${c.accepted} (lost work)`);
    expect(c.failed === 0 && c.stillPending === 0, run, `failed=${c.failed} stillPending=${c.stillPending}`);
  }
  for (const l of run.load ? [run.load] : run.phases ?? []) {
    const unexpected = Object.keys(l.rejected).filter((k) => k !== '503 OVERLOADED');
    expect(unexpected.length === 0, run, `unexpected rejections: ${unexpected.join(', ')}`);
    if (run.scenario === 'baseline') expect(l.acceptedCount === l.sent, run, `baseline rejected ${l.sent - l.acceptedCount}`);
  }
  for (const l of run.levels ?? []) expect(l.completed === l.deliveries && l.failed === 0, run, `worker c=${l.concurrency}: ${l.completed}/${l.deliveries}, failed ${l.failed}`);
  if (run.backlog) expect(run.backlog.recovered, run, 'backlog did not recover');
}
console.log(bad.length ? bad.join('\n') : `OK: ${runs.length} runs, lost=0, failed=0`);
process.exit(bad.length ? 1 : 0);
