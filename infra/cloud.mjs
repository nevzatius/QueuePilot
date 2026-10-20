/* global fetch, AbortSignal, structuredClone */
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export function accessToken() {
  // Fixed command only; never interpolate configuration into a shell command.
  const output = process.platform === 'win32'
    ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& gcloud auth print-access-token --quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : execFileSync('gcloud', ['auth', 'print-access-token', '--quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!output.trim()) throw new Error('No gcloud access token');
  return output.trim();
}

export class CloudError extends Error {
  constructor(status, code) {
    // Never include response bodies, headers, tokens, request descriptions or secret values.
    super(`Cloud request failed: HTTP ${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

export function cloudClient(token) {
  return async (host, path, method = 'GET', body) => {
    const response = await fetch(`https://${host}.googleapis.com/${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
    const value = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new CloudError(response.status, value.error?.status ?? 'UNKNOWN');
    return value;
  };
}

export async function getOrAbsent(client, host, path) {
  try { return await client(host, path); }
  catch (error) {
    if (error instanceof CloudError && error.status === 404 && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
};
export const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Compare only managed fields. Server-populated defaults and output fields are ignored.
export function matches(actual, desired) {
  if (desired === null || typeof desired !== 'object') {
    if (actual === undefined && [0, false, ''].includes(desired)) return true;
    return actual === desired;
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual) || actual.length !== desired.length) return false;
    return desired.every((item) => actual.some((candidate) => matches(candidate, item)));
  }
  return Object.entries(desired).every(([key, value]) => matches(actual?.[key], value));
}

export function mergeBinding(policy, binding) {
  const next = structuredClone(policy);
  next.bindings ??= [];
  let found = next.bindings.find((b) => b.role === binding.role && !b.condition);
  if (!found) { found = { role: binding.role, members: [] }; next.bindings.push(found); }
  found.members = [...new Set([...found.members, ...binding.members])].sort();
  return next;
}

export async function waitOperation(client, host, operation) {
  if (!operation.name || !/(^|\/)operations\//.test(operation.name)) return operation;
  const version = host === 'run' || host === 'cloudtasks' ? 'v2' : 'v1';
  const path = `${version}/${operation.name}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (operation.error) throw new CloudError(500, operation.error.status ?? String(operation.error.code));
    if (operation.done) return operation.response ?? {};
    await delay(2000);
    operation = await client(host, path);
  }
  throw new Error('Operation still pending after 5 minutes; inspect it before rerunning');
}

// Method and options placement are specific to each REST resource, not to IAM in general.
const policyReads = [
  { host: 'iam', path: /^v1\/projects\/[^/]+\/serviceAccounts\/[^/]+$/, method: 'POST', query: true },
  { host: 'cloudtasks', path: /^v2\/projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+$/, method: 'POST' },
  { host: 'cloudresourcemanager', path: /^v1\/projects\/[^/]+$/, method: 'POST' },
  { host: 'run', path: /^v2\/projects\/[^/]+\/locations\/[^/]+\/services\/[^/]+$/, method: 'GET', query: true },
  { host: 'secretmanager', path: /^v1\/projects\/[^/]+\/secrets\/[^/]+$/, method: 'GET', query: true },
];

const duration = (value) => typeof value === 'string' && /^\d+(\.\d{1,9})?s$/.test(value)
  ? `${Number(value.slice(0, -1))}s` : value;

function schedulerFields(value) {
  const retry = value.retryConfig ?? {};
  const normalized = {
    retryCount: retry.retryCount ?? 0, maxRetryDuration: duration(retry.maxRetryDuration ?? '0s'),
  };
  // Backoffs have no effect when retries are disabled; the API can populate its own defaults.
  if (normalized.retryCount !== 0 || normalized.maxRetryDuration !== '0s') {
    Object.assign(normalized, {
      minBackoffDuration: duration(retry.minBackoffDuration ?? '5s'),
      maxBackoffDuration: duration(retry.maxBackoffDuration ?? '3600s'), maxDoublings: retry.maxDoublings ?? 5,
    });
  }
  return { ...value, retryConfig: normalized, attemptDeadline: duration(value.attemptDeadline) };
}

export async function ensurePaused(client, r, current) {
  current ??= await client(r.host, r.path);
  const active = r.host === 'cloudtasks' ? 'RUNNING' : 'ENABLED';
  if (![active, 'PAUSED'].includes(current.state)) throw new Error(`${r.id}: unsafe or unknown state ${current.state ?? 'UNKNOWN'}`);
  if (current.state !== 'PAUSED') {
    // Errors propagate, including when creation succeeded on a previous invocation.
    await client(r.host, `${r.path}:pause`, 'POST', {});
    current = await client(r.host, r.path);
    if (current.state !== 'PAUSED') throw new Error(`${r.id}: pause not confirmed; actual state ${current.state ?? 'UNKNOWN'}`);
  }
  return current;
}

function checkOperation(operation) {
  if (operation.error) throw new CloudError(500, operation.error.status ?? String(operation.error.code));
}

export async function reconcile(client, r, approvals = {}) {
  const call = async (path, method, body) => waitOperation(client, r.host, await client(r.host, path, method, body));
  if (r.kind === 'identity') {
    // generateServiceIdentity is idempotent; no policy is granted by this call.
    await call(r.path, 'POST', {});
    return 'ENSURED';
  }
  if (r.kind === 'iam') {
    const read = policyReads.find((entry) => entry.host === r.host && entry.path.test(r.path));
    if (!read) throw new Error('Unsupported IAM resource; refusing policy access');
    const policy = await client(r.host, `${r.path}:getIamPolicy${read.query ? '?options.requestedPolicyVersion=3' : ''}`,
      read.method, read.query ? undefined : { options: { requestedPolicyVersion: 3 } });
    if (r.id === 'worker-private' && policy.bindings?.some((b) => b.members.some((m) => ['allUsers', 'allAuthenticatedUsers'].includes(m)))) {
      throw new Error('Worker has public IAM bindings; owner must inspect and remove them before continuing');
    }
    const next = mergeBinding(policy, r.body);
    if (equal(policy, next)) return 'NOOP';
    await call(`${r.path}:setIamPolicy`, 'POST', { policy: next });
    return 'UPDATED';
  }
  if (r.kind === 'rules') {
    const release = await getOrAbsent(client, r.host, r.path);
    if (release) {
      const existing = await client(r.host, `v1/${release.rulesetName}`);
      if (matches(existing.source, r.body.source)) return 'NOOP';
    }
    const created = await call(r.parent, 'POST', r.body);
    const body = { name: r.path.slice(3), rulesetName: created.name };
    if (release) await call(r.path, 'PATCH', { release: body, updateMask: 'rulesetName' });
    else await call(r.path.slice(0, r.path.lastIndexOf('/')), 'POST', body);
    return release ? 'UPDATED' : 'CREATED';
  }
  if (r.kind === 'index') {
    let page = r.path;
    while (page) {
      const list = await client(r.host, page);
      for (const index of list.indexes ?? []) {
        const fields = index.fields.filter((f) => f.fieldPath !== '__name__');
        // Composite field order is significant.
        if (index.queryScope === r.body.queryScope && fields.length === r.body.fields.length
          && fields.every((field, i) => equal(field, r.body.fields[i]))) {
          if (index.state === 'NEEDS_REPAIR') throw new Error('Index requires owner repair');
          return index.state === 'READY' ? 'NOOP' : 'PENDING';
        }
      }
      page = list.nextPageToken ? `${r.path}?pageToken=${encodeURIComponent(list.nextPageToken)}` : null;
    }
    const operation = await client(r.host, r.parent, 'POST', r.body);
    checkOperation(operation);
    // Operation completion alone does not prove the index is READY. A subsequent run reads its state.
    return 'PENDING';
  }
  let current = await getOrAbsent(client, r.host, r.path);
  const pausable = ['cloudtasks', 'cloudscheduler'].includes(r.host);
  const wasActive = pausable && current && current.state !== 'PAUSED';
  if (pausable && current) current = await ensurePaused(client, r, current);
  if (r.host === 'cloudtasks' && current) {
    if (current.state === 'DISABLED' || [current.httpTarget, current.appEngineRoutingOverride].some((v) => v && Object.keys(v).length > 0)) {
      throw new Error('Queue is disabled or has routing/authentication overrides; owner must inspect before per-task OIDC');
    }
  }
  if (r.kind === 'api') {
    if (current?.state === 'ENABLED') return 'NOOP';
    await call(`${r.path}:enable`, 'POST', {});
    return 'ENABLED';
  }
  if (r.kind === 'database') {
    if (current) {
      if (!matches(current, r.body)) throw new Error('Database region/type/protection differs; refusing migration');
      return 'NOOP';
    }
    const projectId = r.path.split('/')[2];
    if (approvals.projectId !== projectId || approvals.firestoreLocation !== 'europe-west1'
      || r.body.locationId !== approvals.firestoreLocation) {
      throw new Error('Database creation requires exact project and irreversible Firestore location approval: europe-west1');
    }
  }
  if (r.kind === 'field') {
    if (!current) throw new Error('Firestore field GET returned NOT_FOUND; check database readiness');
    const indexesMatch = equal(current.indexConfig?.indexes ?? [], r.body.indexConfig.indexes)
      && current.indexConfig !== undefined && current.indexConfig.usesAncestorConfig !== true;
    const ttlMatch = !r.body.ttlConfig || ['ACTIVE', 'CREATING'].includes(current.ttlConfig?.state);
    if (indexesMatch && ttlMatch) return current.ttlConfig?.state === 'CREATING' || current.indexConfig.reverting ? 'PENDING' : 'NOOP';
    const operation = await client(r.host, `${r.path}?updateMask=indexConfig${r.body.ttlConfig ? ',ttlConfig' : ''}`, 'PATCH', r.body);
    checkOperation(operation);
    return 'PENDING';
  }
  if (current?.deleted || current?.disabled) throw new Error('Resource is deleted or disabled; owner must inspect');
  const desiredFields = Object.fromEntries(Object.entries(r.body).filter(([key]) => key !== 'name'));
  const matching = r.host === 'cloudscheduler'
    ? matches(schedulerFields(current ?? {}), schedulerFields(desiredFields)) : matches(current, desiredFields);
  if (current && (r.kind === 'createOnly' || matching)) return pausable ? `${wasActive ? 'PAUSED' : 'NOOP'} (state=PAUSED)` : 'NOOP';
  if (!current) {
    if (r.host === 'cloudscheduler') {
      if (!approvals.schedulerImage) return 'DEFERRED (state=ABSENT; target deployment approval required)';
      if (approvals.schedulerImage !== r.targetImage || !/@sha256:[a-f0-9]{64}$/.test(r.targetImage ?? '')) {
        throw new Error('Scheduler approval must match the pinned target worker image');
      }
      const worker = await client('run', r.targetService);
      if (worker.reconciling || worker.terminalCondition?.state !== 'CONDITION_SUCCEEDED'
        || !worker.latestReadyRevision || worker.latestReadyRevision !== worker.latestCreatedRevision
        || worker.template?.containers?.[0]?.image !== r.targetImage) {
        throw new Error('Approved Scheduler target worker is not fully deployed and ready');
      }
    }
    const body = r.kind === 'role' ? { ...r.createBody, role: r.body } : r.body;
    await call(r.parent, 'POST', body);
    if (pausable) await ensurePaused(client, r);
    return pausable ? 'CREATED (state=PAUSED)' : 'CREATED';
  }
  if (['createOnly', 'database'].includes(r.kind)) throw new Error('Unexpected immutable resource drift');
  const updateMask = Object.keys(r.body).filter((k) => k !== 'name').join(',');
  await call(`${r.path}?updateMask=${updateMask}`, 'PATCH', { ...r.body, ...(current.etag ? { etag: current.etag } : {}) });
  if (pausable) await ensurePaused(client, r);
  return pausable ? 'UPDATED (state=PAUSED)' : 'UPDATED';
}
