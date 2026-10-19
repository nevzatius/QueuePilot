## Work package

WP ID: B3
Branch: codex/b3-backend
Agent: Codex
Base: main at 1e07a922b7c40d0e24e5a165207308569efa20cd

## Summary

Implemented verified Google authentication, server-side membership/tenant authorization and Fastify APIs.
Acceptance atomically commits the request, idempotency key and domain-generated event before enqueue.
Added own/admin tenant reads, pagination, tenant metrics, RFC 9457 errors, structured logs and health probes.
Added emulator race/rollback/security coverage and an executable API build with a startup smoke check.

## Ownership check

- [x] Only `packages/core/**` and `apps/api/**` changed; backend tests live in the API workspace.
- [x] Contracts, domain, frontend, cloud infrastructure and shared state documents are untouched.
- [x] Root `pnpm-lock.yaml` is excluded; dependency additions below need integration-owner lock regeneration.

## Acceptance criteria (copy from the WP card)

- [x] Idempotency replay, 409 and logical-expiry takeover are tested, including concurrent creators/takeovers.
- [x] Bootstrap creates only member; injected tenant/admin fields are rejected before writes.
- [x] Cross-tenant and cross-user reads return 404; admin privileges refresh uncached.
- [x] Membership cache follows ADR-010, tested with a fake Clock.
- [x] Admission returns 503 at limits (ADR-012) and executes before persistence.

Bootstrap preserves an existing operator-granted membership; it never grants admin. This follows
the idempotent endpoint behavior and keeps Firestore as the role authority.

## Invariants and ADRs touched

I1/I2: request, key and ACCEPTED event share one transaction; the domain decides replay/conflict/expiry
against a fresh key read. A failed/ambiguous commit yields 503 and no enqueue.
I3-I6: B3 never executes processing transitions; initial state, budgets, event and rules version come
from `planAcceptance`. No worker or reconciler logic is duplicated.
I7/ADR-017: seq 1 is committed before the creator calls enqueue; replays never enqueue. Queue failure
only logs and leaves ACCEPTED/watchdog intact; it cannot produce FAILED or consume attempts.
ADR-008/010: verified Firestore memberships; positive-only bounded caches, uncached privileged reads,
no stale fallback on errors. ADR-009: enforced quotas fail closed until B5. ADR-012: bounded writes.

## Verification

- [x] `corepack pnpm lint` — passed.
- [x] `corepack pnpm typecheck` — passed, including backend unit/integration TypeScript.
- [x] `corepack pnpm test` — 478 tests passed in 19 files (29 new backend unit cases).
- [x] `corepack pnpm build` — passed; `apps/api/dist/server.js` is the executable API artifact.
- [x] `node apps/api/test/build-smoke.mjs` — built server startup, health and unauthenticated API check passed.
- [x] `corepack pnpm --filter @queuepilot/api test:integration` — 14 Auth/Firestore emulator tests passed.

Emulator coverage includes unauthorized/provider/email verification, bootstrap/role injection,
atomic acceptance observed at enqueue, 8 concurrent same-key calls, canonical replay/conflict,
4 concurrent logical-expiry takeovers, UID/tenant key isolation, hidden detail reads, scoped pagination,
immediate admin revocation, tenant metrics/cache, actual emulator commit rejection with full rollback,
and enqueue failure leaving ACCEPTED with one event/watchdog. No B4 T1-T13 completion claim is made.

`corepack pnpm test:integration` (existing foundation suite): 2 passed (Auth and Firestore),
1 failed because Redis is unavailable (`ECONNREFUSED 127.0.0.1:6379`). No test was skipped or
replaced with a mock. Rerun this command with local Redis before the merge gate.

## Security and cost impact

No cloud operations, credentials, paid resources, IAM changes, push or deploy. No secrets added.
Server-generated correlation IDs, sanitized dependency failures, redacted logs and strict create bodies.
Public readiness performs one Firestore read; ingestion quotas are fail closed until B5. Metrics use
aggregate status counts, with projected pending-document reads for `stuck` on a 5s cache miss.

## Handoff notes (for PROJECT_STATE.md)

B3 ingestion/read/session APIs work against local Auth and Firestore emulators.
B4 must connect QueuePort and implement worker/reconciler; until then accepted requests remain durable.
B5 must connect Redis quota/rate/cache adapters; enforced quota tenants currently cannot submit.
Use API package `start` (server.js); the old root index.js bundle is not a runnable Firebase SDK artifact.
Root CI integration discovery and bundling updates require integration-owner changes outside this scope.

## CCRs and ADR proposals

No contract or domain changes required; no ADR changes proposed. Responses are validated with unchanged
contract schemas. Integration requests outside the user's allowed paths:

1. Regenerate root lockfile for the manifest changes, then run frozen install/CI. New dependencies:
   core: `@queuepilot/contracts`/`@queuepilot/domain` workspace links, `firebase-admin@14.5.0`,
   `pino@10.4.0`, `zod@^4.6.7`; API: `@queuepilot/contracts` workspace link,
   `fastify@5.12.7`, `fastify-type-provider-zod@7.0.0`, `firebase-admin@14.5.0`,
   `pino@10.4.0`, `zod@^4.6.7` (core workspace link existed already).
2. Update root `scripts/build.mjs` to leave Firebase/Fastify/Pino/Zod runtime dependencies external,
   or use `apps/api/dist/server.js` as the canonical API artifact in deployment packaging. The API-local
   build/start scripts already produce/run this verified artifact; no root or infrastructure files changed.
3. Add `apps/api/test/integration/**/*.test.ts` to root integration test discovery (or call the API's
   emulator script in CI). Its local config can run both backend and foundation suites.
4. The B2 follow-up to wire `node --test infra/offline.test.mjs infra/targeted.test.mjs` into root CI/test
   remains outside this B3-only ownership scope.
5. Consider a tenant/watchdog composite index for aggregate stuck counts before large-backlog polling;
   current implementation stays compatible with existing indexes and records the read-cost limitation.

Local tooling: `pnpm` is not on PATH; `corepack pnpm` uses the repository-pinned 10.32.1. On Windows
with Java 26, Firebase CLI leaves a Firestore child listening after shutdown; only verified test-owned
emulator children were terminated. The emulator's permissive client rules are not a production rules test;
API authorization is covered, and infrastructure/rules remain unchanged.
