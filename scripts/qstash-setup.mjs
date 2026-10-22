/* global fetch */
import { pathToFileURL } from 'node:url';
import { EXIT, ScriptError, parseOptions, runCli } from './lib/ops.mjs';
import { QStashRest, checkApproval, describeIds, forDestination, isCurrent, readToken, resolveSettings } from './lib/qstash.mjs';

// Creates or updates the QStash schedule that ticks the reconciler every 60 minutes (ADR-019): a POST to
// ${QP_WORKER_URL}/internal/reconcile. Idempotent: an existing schedule for that destination is updated in
// place or left alone, never duplicated. Dry run is the default (ADR-016); the only call it can make is one
// read-only listing, and none at all when QSTASH_TOKEN is not set.
//
//   QP_WORKER_URL=https://<worker origin> QSTASH_TOKEN=... [QSTASH_URL=https://<region>.qstash.upstash.io]
//   node scripts/qstash-setup.mjs [--retries 2] [--timeout 90s]                               (dry run)
//   node scripts/qstash-setup.mjs --apply --approve-destination https://<worker origin>/internal/reconcile
//
// The token comes from the environment only: there is no --token option, and nothing here prints it.
// Exit: 0 ok, 2 usage, 3 refused, 4 state conflict (duplicates, or the re-read does not match), 5 I/O.

const OPTIONS = {
  retries: { type: 'string' }, timeout: { type: 'string' }, apply: { type: 'boolean', default: false }, 'approve-destination': { type: 'string' },
};

export function parseSetupArgs(argv) {
  return parseOptions(argv, OPTIONS);
}

export async function runSetup(values, deps) {
  const { io, env } = deps;
  const settings = resolveSettings({ env, values });
  const apply = values.apply;
  checkApproval({ apply, approved: values['approve-destination'], destination: settings.destination });
  const token = readToken(env);
  io.out(`${apply ? 'APPLY' : 'DRY RUN'}: QStash reconcile schedule`);
  io.out(`  destination: POST ${settings.destination}`);
  io.out(`  cron: ${settings.cron} (every 60 minutes, UTC)  retries: ${settings.retries}  timeout: ${settings.timeout}`);
  if (!token) {
    if (apply) throw new ScriptError(EXIT.REFUSED, 'QSTASH_TOKEN is not set; refusing to apply');
    io.out('QSTASH_TOKEN is not set: the existing schedule was not looked up. Nothing was called. Set the token for a read-only comparison.');
    return EXIT.OK;
  }
  const client = new QStashRest({ baseUrl: settings.baseUrl, token, fetchImpl: deps.fetch });
  const matches = forDestination(await client.list(), settings.destination);
  if (matches.length > 1) {
    throw new ScriptError(EXIT.STATE, `${matches.length} schedules already target this destination (${describeIds(matches)}); run qstash-shutdown.mjs to remove them, then rerun`);
  }
  const existing = matches[0];
  const unchanged = existing !== undefined && isCurrent(existing, settings);
  const action = existing === undefined ? 'create' : unchanged ? 'unchanged' : 'update';
  if (!apply) {
    io.out(`Would ${action === 'unchanged' ? 'leave the existing schedule unchanged' : action === 'create' ? 'create the schedule' : `update schedule ${describeIds(matches)} in place`}.`);
    io.out('Nothing was written. Writes need --apply and --approve-destination=<destination>.');
    return EXIT.OK;
  }
  if (unchanged) {
    io.out(`schedule ${describeIds(matches)}: unchanged (no write made)`);
    return EXIT.OK;
  }
  const scheduleId = await client.upsert(settings, existing?.scheduleId);
  io.out(`schedule ${scheduleId ?? '(id not returned)'}: ${action === 'create' ? 'created' : 'updated'}`);
  const after = forDestination(await client.list(), settings.destination);
  if (after.length !== 1 || !isCurrent(after[0], settings)) {
    throw new ScriptError(EXIT.STATE, 'The re-read does not show exactly one schedule with the wanted settings; inspect it in the Upstash console before rerunning');
  }
  io.out('Confirmed by re-read: exactly one schedule for the destination with the wanted settings.');
  return EXIT.OK;
}

export const productionDeps = (io) => ({ io, env: process.env, fetch });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(async (argv, io) => runSetup(parseSetupArgs(argv), productionDeps(io)), process.argv.slice(2));
}
