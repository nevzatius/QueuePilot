/* global fetch, AbortSignal */
// Shared safety layer for owner-operated scripts (grant-role, seed-demo). Pure where possible so
// tests can run without credentials. Nothing here reads files, environment secrets or tokens by
// itself: the caller passes the environment and the token provider explicitly.

import { parseArgs } from 'node:util';

export const EXIT = { OK: 0, USAGE: 2, REFUSED: 3, STATE: 4, IO: 5 };

export class ScriptError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** Strict argument parsing: unknown flags, positionals and repeated values are usage errors. */
export function parseOptions(argv, options) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: false, tokens: true }); }
  catch (error) { throw new ScriptError(EXIT.USAGE, `Invalid arguments: ${error.code ?? 'unparseable'}`); }
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new ScriptError(EXIT.USAGE, `Invalid arguments: --${token.name} given more than once`);
    seen.add(token.name);
  }
  return parsed.values;
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const EMULATOR_HOST = /^(localhost|127\.0\.0\.1):\d{2,5}$/;
export const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,62}$/; // mirrors TenantIdSchema in packages/contracts
export const UID = /^[A-Za-z0-9_-]{1,128}$/; // Firebase uid charset; rejects separators, wildcards and spaces

/**
 * Decide where a script may write. Fail closed: every ambiguity is an error.
 * - Emulator mode (FIRESTORE_EMULATOR_HOST set) accepts only a loopback host and a demo-* project.
 * - Cloud mode rejects demo-*, placeholder and production-looking projects and, for writes, needs
 *   --approve-project to repeat the project ID exactly.
 */
export function resolveTarget({ project, approveProject, apply, env }) {
  if (!project) throw new ScriptError(EXIT.USAGE, 'Missing --project');
  if (!PROJECT_ID.test(project)) throw new ScriptError(EXIT.USAGE, 'Invalid --project value');
  if (approveProject !== undefined && approveProject !== project) {
    throw new ScriptError(EXIT.REFUSED, '--approve-project does not match --project; refusing');
  }
  const emulatorHost = env.FIRESTORE_EMULATOR_HOST;
  if (emulatorHost !== undefined && emulatorHost !== '') {
    if (!EMULATOR_HOST.test(emulatorHost) || !project.startsWith('demo-')) {
      throw new ScriptError(EXIT.REFUSED, 'FIRESTORE_EMULATOR_HOST requires a loopback address and a demo-* project; refusing');
    }
    if (apply && approveProject !== project) throw new ScriptError(EXIT.REFUSED, 'Writes require --approve-project=<project>');
    return { mode: 'emulator', project, emulatorHost };
  }
  if (project.startsWith('demo-') || project.startsWith('replace-') || /(^|[-_])(prod|production)([-_]|$)/i.test(project)) {
    throw new ScriptError(EXIT.REFUSED, 'Refusing a demo-*, placeholder or production-looking project outside the emulator');
  }
  if (apply && approveProject !== project) throw new ScriptError(EXIT.REFUSED, 'Writes require --approve-project=<project>');
  return { mode: 'cloud', project };
}

/** Cloud mode only: the project must exist, be ACTIVE, carry the demo label and, when given, match the project number (same rules as infra/apply.mjs). */
export async function verifyCloudProject(target, cloud, projectNumber) {
  if (target.mode !== 'cloud') return;
  let info;
  try { info = await cloud.client('cloudresourcemanager', `v1/projects/${target.project}`); }
  catch { throw new ScriptError(EXIT.IO, 'Could not read the project; check gcloud login and project access'); }
  if (info.projectId !== target.project || info.lifecycleState !== 'ACTIVE') {
    throw new ScriptError(EXIT.REFUSED, 'Project identity or state mismatch; refusing');
  }
  if (projectNumber !== undefined && info.projectNumber !== projectNumber) {
    throw new ScriptError(EXIT.REFUSED, 'Project number mismatch; refusing');
  }
  if (info.labels?.['queuepilot-environment'] !== 'demo') {
    throw new ScriptError(EXIT.REFUSED, 'Project is not labelled queuepilot-environment=demo; refusing');
  }
}

const encode = (value) => {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (value && typeof value === 'object') return { mapValue: { fields: encodeFields(value) } };
  throw new TypeError('Unsupported Firestore value');
};
export const encodeFields = (object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, encode(value)]));

const decode = (value) => {
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('mapValue' in value) return decodeFields(value.mapValue.fields ?? {});
  return undefined;
};
export const decodeFields = (fields) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decode(value)]));

/**
 * Minimal Firestore REST client: get, create-only and precondition-guarded update.
 * Response bodies are never echoed in errors.
 */
export class FirestoreRest {
  constructor({ target, token, fetchImpl = fetch }) {
    this.target = target;
    this.token = token;
    this.fetch = fetchImpl;
    this.base = target.mode === 'emulator' ? `http://${target.emulatorHost}` : 'https://firestore.googleapis.com';
  }

  url(path) {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `${this.base}/v1/projects/${this.target.project}/databases/(default)/documents/${encoded}`;
  }

  async call(url, init = {}) {
    const bearer = this.target.mode === 'emulator' ? 'owner' : await this.token();
    let response;
    try {
      response = await this.fetch(url, { ...init, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000) });
    } catch { throw new ScriptError(EXIT.IO, 'Firestore request failed: network error'); }
    const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
    return { status: response.status, body };
  }

  failure(status, body) {
    return new ScriptError(EXIT.IO, `Firestore request failed: HTTP ${status} ${body?.error?.status ?? 'UNKNOWN'}`);
  }

  async get(path) {
    const { status, body } = await this.call(this.url(path));
    if (status === 404) return null;
    if (status !== 200) throw this.failure(status, body);
    return { data: decodeFields(body.fields ?? {}), updateTime: body.updateTime };
  }

  /** Returns true when created, false when the document already exists. Never overwrites. */
  async create(collection, id, data) {
    const { status, body } = await this.call(`${this.url(collection)}?documentId=${encodeURIComponent(id)}`,
      { method: 'POST', body: JSON.stringify({ fields: encodeFields(data) }) });
    if (status === 409) return false;
    if (status !== 200) throw this.failure(status, body);
    return true;
  }

  /**
   * Updates only the given fields and only if the document is unchanged since `updateTime`.
   * Uses documents:commit with the precondition in the body: the emulator ignores the equivalent
   * query parameter on PATCH, so a query-parameter precondition could not be tested locally.
   */
  async update(path, data, updateTime) {
    const name = `projects/${this.target.project}/databases/(default)/documents/${path}`;
    const write = { update: { name, fields: encodeFields(data) }, updateMask: { fieldPaths: Object.keys(data) }, currentDocument: { updateTime } };
    const { status, body } = await this.call(`${this.base}/v1/projects/${this.target.project}/databases/(default)/documents:commit`,
      { method: 'POST', body: JSON.stringify({ writes: [write] }) });
    if (['FAILED_PRECONDITION', 'ABORTED'].includes(body?.error?.status)) throw new ScriptError(EXIT.STATE, 'Document changed concurrently; rerun to re-evaluate');
    if (status !== 200) throw this.failure(status, body);
  }
}

/** Run a script body; map ScriptError to its exit code and hide stack traces and unknown details. */
export async function runCli(main, argv, io = { out: console.log, err: console.error }) {
  try { return await main(argv, io); }
  catch (error) {
    if (error instanceof ScriptError) { io.err(error.message); return error.exitCode; }
    io.err('Unexpected failure; no details are printed to avoid leaking sensitive data');
    return EXIT.IO;
  }
}
