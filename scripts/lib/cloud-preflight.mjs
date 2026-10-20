import { CloudError, getOrAbsent } from '../../infra/cloud.mjs';
import { specification } from '../../infra/spec.mjs';

// Read-only cloud preflight. Every request is a GET (the client wrapper in scripts/preflight.mjs and the
// tests enforce it). Statuses: PASS (matches the plan), FAIL (exists but contradicts the plan or a safety
// rule), ABSENT (not created yet; expected before its stage), UNKNOWN (permission, network or an
// unexpected answer: never treated as success). Resource paths come from infra/spec.mjs only.

const reason = (error) => (error instanceof CloudError ? `HTTP ${error.status} ${error.code}` : 'request failed');
const PUBLIC_MEMBERS = ['allUsers', 'allAuthenticatedUsers'];

/** Artifact Registry resource name for a configured image reference (docs: dockerImages/<image>@sha256:<digest>). */
export function dockerImagePath(config, image) {
  const match = new RegExp(`^${config.region}-docker\\.pkg\\.dev/${config.projectId}/([a-z0-9_-]+)/([a-z0-9/_-]+)@(sha256:[a-f0-9]{64})$`).exec(image ?? '');
  if (!match) return null;
  const [, repository, name, digest] = match;
  return `v1/projects/${config.projectId}/locations/${config.region}/repositories/${repository}/dockerImages/${encodeURIComponent(`${name}@${digest}`)}`;
}

export async function runCloudPreflight(config, client) {
  const results = [];
  const add = (id, status, detail) => results.push({ id, status, detail });
  const spec = specification(config);
  const find = (id, host) => spec.find((r) => r.id === id && r.host === host);
  const probe = async (id, host, path, judge) => {
    try {
      const value = await getOrAbsent(client, host, path);
      if (value === null) add(id, 'ABSENT', 'not found');
      else { const [status, detail] = judge(value); add(id, status, detail); }
    } catch (error) { add(id, 'UNKNOWN', reason(error)); }
  };

  // 1. Identity first: on any doubt nothing else is read.
  let project;
  try { project = await client('cloudresourcemanager', `v1/projects/${config.projectId}`); }
  catch (error) { add('project', 'UNKNOWN', `${reason(error)}; no further checks`); return results; }
  if (project.projectId !== config.projectId || project.projectNumber !== config.projectNumber || project.lifecycleState !== 'ACTIVE'
      || project.labels?.['queuepilot-environment'] !== 'demo') {
    add('project', 'FAIL', 'identity, number, ACTIVE state or queuepilot-environment=demo label does not match; no further checks');
    return results;
  }
  add('project', 'PASS', 'ACTIVE, number matches, labelled queuepilot-environment=demo');

  // 2. Billing (read needs only resourcemanager.projects.get). Linked billing is a precondition, not a cost limit.
  try {
    const billing = await client('cloudbilling', `v1/projects/${config.projectId}/billingInfo`);
    add('billing', billing.billingEnabled === true ? 'PASS' : 'FAIL', billing.billingEnabled === true
      ? 'billing enabled (budget alerts are not readable here: confirm them in the console)' : 'billing is not enabled');
  } catch (error) { add('billing', 'UNKNOWN', reason(error)); }

  // 3. APIs enabled by the bootstrap stage.
  for (const api of spec.filter((r) => r.kind === 'api')) {
    await probe(`api:${api.id}`, 'serviceusage', api.path, (s) => (s.state === 'ENABLED' ? ['PASS', 'enabled'] : ['ABSENT', `state ${s.state ?? 'UNKNOWN'}`]));
  }

  // 4. Firestore location is irreversible (ADR-007).
  const database = spec.find((r) => r.kind === 'database');
  await probe('firestore', database.host, database.path, (d) => (d.locationId === config.region && d.type === 'FIRESTORE_NATIVE'
    ? ['PASS', `${d.locationId}, native mode, delete protection ${d.deleteProtectionState === 'DELETE_PROTECTION_ENABLED' ? 'on' : 'OFF'}`]
    : ['FAIL', 'existing database has another location or type: stop, nothing can migrate it']));

  // 5. Pinned images exist in this project's repository.
  for (const [id, image] of [['image:api', config.apiImage], ['image:worker', config.workerImage]]) {
    const path = dockerImagePath(config, image);
    if (!path) add(id, 'FAIL', 'not a pinned image of this project and region');
    else await probe(id, 'artifactregistry', path, () => ['PASS', 'digest present']);
  }

  // 6. Secret version metadata only; the payload is never accessed.
  await probe('secret:redis-url', 'secretmanager', `v1/projects/${config.projectId}/secrets/redis-url/versions/${config.redisSecretVersion}`,
    (v) => (v.state === 'ENABLED' ? ['PASS', `pinned version ${config.redisSecretVersion} enabled`] : ['FAIL', `pinned version state ${v.state ?? 'UNKNOWN'}`]));

  // 7. Background work must stay paused until the owner activates it.
  for (const [id, host] of [['qp-process', 'cloudtasks'], ['qp-reconcile', 'cloudscheduler']]) {
    const resource = find(id, host);
    await probe(id, host, resource.path, (r) => (r.state === 'PAUSED' ? ['PASS', 'PAUSED']
      : ['FAIL', `state ${r.state ?? 'UNKNOWN'}: expected PAUSED before owner activation`]));
  }

  // 8. Services: image as configured; worker never public.
  for (const [id, image] of [['qp-worker', config.workerImage], ['qp-api', config.apiImage]]) {
    const service = find(id, 'run');
    await probe(`run:${id}`, 'run', service.path, (s) => {
      const deployed = s.template?.containers?.[0]?.image;
      return deployed === image ? ['PASS', 'deployed with the configured digest'] : ['FAIL', 'deployed image differs from the configuration'];
    });
    await probe(`run-iam:${id}`, 'run', `${service.path}:getIamPolicy?options.requestedPolicyVersion=3`, (policy) => {
      const isPublic = (policy.bindings ?? []).some((b) => b.role === 'roles/run.invoker' && (b.members ?? []).some((m) => PUBLIC_MEMBERS.includes(m)));
      if (id === 'qp-worker') return isPublic ? ['FAIL', 'worker is publicly invokable'] : ['PASS', 'no public invoker'];
      return ['PASS', isPublic ? 'public invoker present (expected after the iam stage)' : 'private (the iam stage has not exposed it)'];
    });
  }
  return results;
}

export const cloudSummary = (results) => {
  const failed = results.some((r) => r.status === 'FAIL');
  const unknown = results.some((r) => r.status === 'UNKNOWN');
  return { failed, unknown, exitCode: failed ? 1 : unknown ? 3 : 0 };
};
