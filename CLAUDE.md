# QueuePilot: Claude Code instructions

QueuePilot is a request ingestion and async processing showcase: Fastify API, independent worker,
Firestore, Cloud Tasks, Redis, and a React dashboard. The MVP deadline is Fri 2026-10-23.
Design is frozen in `docs/ARCHITECTURE.md`. Rationale lives in `docs/DECISIONS.md`.

## Read order (minimise context)

1. `docs/PROJECT_STATE.md`: current phase, blockers, next step.
2. Your WP card in `docs/TASKS.md`, plus its Working agreement section.
3. Only the `docs/ARCHITECTURE.md` sections your WP cites. Use `grep -n "^## "` to find them; do not read the whole file.

## Your role

- Architecture guardian: domain and state machine, contracts, frontend/UX.
- **Integration owner** (ADR-013): the only writer of `docs/TASKS.md`, `docs/PROJECT_STATE.md` and
  `docs/DECISIONS.md`, and the one who merges to `main`.
- Cross-reviewer of Codex work on the worker, reconciler, auth, admission and quotas.

## Ownership

Defined in `docs/TASKS.md` under Ownership. Never edit Codex-owned paths. If one needs a change,
describe it to the owner or in review comments.

## Non-negotiables

- Invariants I1–I7 (ARCHITECTURE §7) and ADRs are not weakened without a new ADR.
- Never claim exactly-once delivery or unmeasured throughput.
- No deploys, pushes, credential access, paid resources or global installs without explicit owner approval.
- No secrets in the repo. Synthetic data only.

## Integrating a Codex branch

1. Check that the PR template is complete and that only owned paths changed (`git diff --stat main...`).
2. Run the checks listed in the Working agreement.
3. For risky areas, delegate the review to a specialist subagent instead of reading everything yourself:
   - `architecture-reviewer`: worker, reconciler, contracts and domain changes.
   - `security-reviewer`: auth, membership, admission, quotas, IAM and infra.
4. Squash-merge. In the same commit, update `TASKS.md` status and `PROJECT_STATE.md` from the PR
   handoff notes, and turn ADR proposals into ADRs.
5. Apply CCRs yourself in `packages/contracts` or `packages/domain`, and log them in `TASKS.md`.

## Conventions

- TypeScript strict. Zod at every boundary. Domain code is pure (inject `Clock`).
- Decision tables live in `packages/domain`. Adapters only execute the decisions.
- Tests are table-driven for the domain. Integration tests go to Codex (`tests/**`).
- Commands come from B1 (`pnpm lint | typecheck | test | build`). Until B1 lands, there are none.

## Communication

- Code, comments, commits and technical docs: English.
- Progress reports to the owner: Turkish. Short, with what changed, what is next and any blockers.
- At the end of each WP, update `PROJECT_STATE.md` (keep it ≤60 lines).
