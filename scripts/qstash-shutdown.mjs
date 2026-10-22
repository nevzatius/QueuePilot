/* global fetch */
import { pathToFileURL } from 'node:url';
import { EXIT, ScriptError, parseOptions, runCli } from './lib/ops.mjs';
import { QStashRest, checkApproval, describeIds, forDestination, readToken, resolveSettings } from './lib/qstash.mjs';

// Deletes the QStash reconcile schedule created by qstash-setup.mjs: only schedules whose destination is exactly
// ${QP_WORKER_URL}/internal/reconcile, never another schedule on the account. QueuePilot publishes tasks directly
// (no QStash queue exists), so there is nothing else to remove here. Dry run is the default (ADR-016): it
// lists what it would delete using one read-only call. Messages already published are not recalled.
//
//   QP_WORKER_URL=https://<worker origin> QSTASH_TOKEN=... [QSTASH_URL=...]
//   node scripts/qstash-shutdown.mjs                                                                  (dry run)
//   node scripts/qstash-shutdown.mjs --apply --approve-destination https://<worker origin>/internal/reconcile
//
// Exit: 0 ok, 2 usage, 3 refused, 4 state conflict (a matching schedule remains), 5 I/O.

const OPTIONS = { apply: { type: 'boolean', default: false }, 'approve-destination': { type: 'string' } };

export function parseShutdownArgs(argv) {
  return parseOptions(argv, OPTIONS);
}

export async function runQStashShutdown(values, deps) {
  const { io, env } = deps;
  const settings = resolveSettings({ env, values: {} });
  const apply = values.apply;
  checkApproval({ apply, approved: values['approve-destination'], destination: settings.destination });
  const token = readToken(env);
  if (!token) throw new ScriptError(EXIT.REFUSED, 'QSTASH_TOKEN is not set; the schedule cannot be looked up');
  io.out(`${apply ? 'APPLY' : 'DRY RUN'}: delete QStash schedules whose destination is POST ${settings.destination}`);
  const client = new QStashRest({ baseUrl: settings.baseUrl, token, fetchImpl: deps.fetch });
  const matches = forDestination(await client.list(), settings.destination);
  if (matches.length === 0) {
    io.out('No matching schedule: nothing to delete.');
    return EXIT.OK;
  }
  io.out(`${apply ? 'Deleting' : 'Would delete'} ${matches.length} schedule(s): ${describeIds(matches)}`);
  if (!apply) {
    io.out('Nothing was deleted. Deleting needs --apply and --approve-destination=<destination>.');
    return EXIT.OK;
  }
  for (const entry of matches) {
    if (typeof entry.scheduleId !== 'string') throw new ScriptError(EXIT.STATE, 'A matching schedule has no id in the listing; delete it in the Upstash console');
    io.out(`schedule ${entry.scheduleId}: ${(await client.remove(entry.scheduleId)) ? 'deleted' : 'already gone'}`);
  }
  const remaining = forDestination(await client.list(), settings.destination);
  if (remaining.length > 0) throw new ScriptError(EXIT.STATE, `Still listed after deletion: ${describeIds(remaining)}; delete in the Upstash console`);
  io.out('Confirmed by re-read: no schedule remains for the destination.');
  return EXIT.OK;
}

export const productionDeps = (io) => ({ io, env: process.env, fetch });

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(async (argv, io) => runQStashShutdown(parseShutdownArgs(argv), productionDeps(io)), process.argv.slice(2));
}
