# QueuePilot

Request ingestion and asynchronous processing showcase. The frozen design is in
[ARCHITECTURE.md](docs/ARCHITECTURE.md); work ownership is in [TASKS.md](docs/TASKS.md).

## Local foundation

Use Node 24 and pnpm 10.32.1 (pinned in `package.json`). If pnpm is not on PATH,
prefix the commands below with `corepack`, for example `corepack pnpm install`.
No global tool installation is required. Integration tests additionally need
Java 21 or later and a local Redis server on port 6379.
On Windows, put the JDK's `bin` directory before Oracle's `javapath` launcher on
PATH so the emulator process can shut down cleanly.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
node apps/api/dist/index.js
node apps/worker/dist/index.js
```

`pnpm test:integration` starts and stops Firestore (8080) and Auth (9099) emulators
under `demo-queuepilot`. It never needs a Firebase login. Redis must already be
running; `REDIS_URL` defaults to `redis://127.0.0.1:6379`. Tests reject remote
service addresses and create isolated temporary data. `pnpm emulators` starts the
same emulators interactively. `.env.example` documents local settings; scripts
do not automatically load `.env` files. Emulator rules are intentionally the
default local permissive rules; deployment rules belong to B2.

## Workspace and build

- `apps/*` and `packages/*` are pnpm workspaces; internal dependencies use
  `workspace:*`, without TypeScript path aliases.
- The B1 skeleton contains `@queuepilot/core`, `@queuepilot/api`, and
  `@queuepilot/worker`. API and worker entry points have no server behavior yet.
- `tsconfig.json` is a solution config. Strict NodeNext project references build
  declaration files for core, API, worker, and test tooling. Root typecheck also
  runs every workspace's own typecheck script, including contracts after A1 is
  integrated.
- `tsconfig.contracts.json` provides a composite reference to A1 source files
  without changing A1's package config. It is empty before integration; generated
  declarations live under root `dist/contracts-types`.
- Workspace source exports are for tooling and bundlers. `scripts/build.mjs`
  bundles API and worker to Node 24 ESM in `apps/*/dist/index.js`; those are the
  executable artifacts. Declaration output is not a deployment artifact.
- ESLint enforces the dependency direction from architecture section 3 for
  package imports, relative imports, re-exports, and literal dynamic imports.
- Root Vitest discovers package and application unit tests, including
  `packages/contracts/test/*.test.ts` after A1 integration. Integration tests use
  a separate config and cannot silently pass without the local services.

CI runs frozen installation, lint, typecheck, unit tests, real emulator/Redis
integration tests, build, and Node artifact smoke tests on Linux with Java 21
and Redis 7.4. No cloud credentials or deployment step are configured.
