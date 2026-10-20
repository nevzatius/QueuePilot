# QueuePilot API image. Build context MUST be the repository root:
#   docker build -f apps/api/Dockerfile -t queuepilot-api:local .
# Nothing here pushes, deploys or touches any cloud resource.

# Base image: Node 24 LTS line (package.json engines ">=24 <25"), Debian 12 "slim" for glibc-based
# native modules (protobufjs/grpc dependencies of firebase-admin). Pinned by tag AND manifest-list
# digest so rebuilds are reproducible; bump both deliberately (see docs/DEPLOYMENT_RUNBOOK.md).
ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
# Frozen lockfile: the build fails instead of resolving anything new.
RUN pnpm install --frozen-lockfile
# esbuild bundles the workspace TypeScript into dist/server.js and keeps SDK packages (including
# ioredis) external, so they must be present in node_modules at runtime.
RUN pnpm --filter @queuepilot/api build
# Production dependencies only. The bundle inlines @queuepilot/*, so the copied workspace sources
# are removed; a stray runtime import of them would fail loudly at startup.
RUN pnpm --filter @queuepilot/api deploy --prod --legacy /out \
 && rm -rf /out/node_modules/@queuepilot

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Files stay root-owned: the runtime user can read but not modify the application or its dependencies.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist/server.js /repo/apps/api/dist/server.js.map ./dist/
# Non-root. No environment files, keys or credentials are copied; configuration arrives through
# environment variables and Secret Manager mounts at deploy time.
USER node
# Cloud Run supplies PORT (8080 in infra/spec.mjs); the application defaults to 8080 as well.
EXPOSE 8080
# Cloud Run ignores HEALTHCHECK; it helps `docker run`. /health is public and does no IO.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Exec form with node as PID 1: SIGTERM reaches the process and apps/api/src/index.ts closes Fastify,
# Redis and Firestore. Do not wrap in a shell or `pnpm start` (they do not forward signals).
CMD ["node", "dist/server.js"]
