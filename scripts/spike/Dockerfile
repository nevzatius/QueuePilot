# Owner builds from repository root and deploys only a resulting immutable digest.
FROM node:24.18.0-slim
WORKDIR /probe
COPY scripts/spike/package.json scripts/spike/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY scripts/spike/server.mjs ./server.mjs
USER node
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
