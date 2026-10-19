import { build } from 'esbuild';

// Workspace packages export TypeScript sources. Bundle them into Node ESM artifacts;
// plain tsc output would still point at those source exports at runtime.
for (const app of ['api', 'worker']) {
  await build({
    entryPoints: [`apps/${app}/src/index.ts`],
    outfile: `apps/${app}/dist/index.js`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    external: ['firebase-admin/*', 'fastify', 'fastify-type-provider-zod', 'pino', 'zod', 'google-auth-library'],
    logLevel: 'info',
  });
}
