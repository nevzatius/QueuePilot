import { build } from 'esbuild';

await build({ entryPoints: ['src/index.ts'], outfile: 'dist/server.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', sourcemap: true,
  external: ['firebase-admin/*', 'fastify', 'fastify-type-provider-zod', 'pino', 'zod', 'google-auth-library'],
});
