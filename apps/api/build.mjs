import { build } from 'esbuild';

// Keep CJS SDKs and their runtime resources in node_modules. Bundle workspace TypeScript only.
// The B1 root bundler still writes index.js; server.js is the executable B3 artifact.
await build({
  entryPoints: ['src/index.ts'], outfile: 'dist/server.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', sourcemap: true,
  external: ['firebase-admin/*', 'fastify', 'fastify-type-provider-zod', 'pino', 'zod', 'google-auth-library', 'ioredis'],
});
