import { createRuntime } from './runtime.js';

const { app, config } = createRuntime();
try { await app.listen({ host: '0.0.0.0', port: config.PORT }); }
catch { app.log.error({ code: 'STARTUP_FAILED' }, 'API failed to start'); await app.close(); process.exitCode = 1; }
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
