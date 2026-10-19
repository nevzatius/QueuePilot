# QueuePilot: Codex instructions

QueuePilot is a request ingestion and async processing showcase: Fastify API, independent worker,
Firestore, Cloud Tasks, Redis, and a React dashboard. The MVP deadline is Fri 2026-10-23.
Design is frozen in `docs/ARCHITECTURE.md`. Rationale lives in `docs/DECISIONS.md`.

## Read order (minimise context)

1. `docs/PROJECT_STATE.md`: current phase and blockers.
2. Your WP card in `docs/TASKS.md` (B1–B7), plus its Working agreement section.
3. Only the `docs/ARCHITECTURE.md` sections your card cites. Use `grep -n "^## "`; do not read everything.

## Your role

Backend infrastructure: Firestore and Cloud Tasks integration, Redis, CI/CD, integration and load
tests, and deployment scripts. You implement adapters that **execute** decisions returned by
`packages/domain`. Do not re-implement the state machine logic.

## Ownership

Defined in `docs/TASKS.md` under Ownership. You must not edit:
- `packages/contracts/**` or `packages/domain/**`. Request changes with a **CCR** in your PR description.
- `docs/TASKS.md`, `docs/PROJECT_STATE.md` or `docs/DECISIONS.md`. Claude Code is the integration
  owner (ADR-013). Put status, handoff notes and ADR proposals in your PR description instead.
- `apps/web/**`, `CLAUDE.md` or `.claude/**`.

## Branch and PR procedure

- Branch `codex/<wp>-<slug>` from the latest `main`. One WP per branch. Only one active Codex branch at a time.
- Before handing off: rebase on `main`, run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`,
  plus integration tests if you touched IO. Fill in every section of `.github/PULL_REQUEST_TEMPLATE.md`.
- Do not merge to `main` yourself. Do not push, deploy, use credentials, create cloud resources or
  install global tools without explicit owner approval. Infra scripts are written by you and run by the owner.

## Non-negotiables

- Invariants I1–I7 (ARCHITECTURE §7). Every guarded transaction re-checks `status`, `dispatch.seq`
  and `leaseId` inside the transaction.
- Budgets come from Firestore `processing.attempts`, never from Cloud Tasks headers (§8).
- getTask errors other than NOT_FOUND are `PROBE_UNKNOWN` and never mean absence (ADR-011).
- Quotas fail closed in production. Burst limits may degrade (ADR-009).
- Admission control runs before any Firestore write on ingestion (ADR-012).
- Membership cache semantics follow ADR-010 exactly.
- Fault-injection flags (`QP_FAULT_*`) must make the service refuse to start when `QP_ENV=production`.
- No secrets in the repo: only `.env.example`. Logs redact `authorization`, cookies and `description`.

## Conventions

- TypeScript strict, ESM, Node 24. Fastify with a Zod type provider. Pino JSON logs with `correlationId`.
- Interfaces only at IO seams (ARCHITECTURE §3). No DI container and no generic repository.
- Tests: Vitest. Integration tests use the Firebase emulator, Redis and LocalDispatchQueue with a fake `Clock`.
- Never invent benchmark numbers. Results JSON must record environment, commit, config and repetitions.

## Communication

- Code, comments, commits and technical docs: English.
- Progress messages to the owner: Turkish, short.
