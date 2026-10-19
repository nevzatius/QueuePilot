import { createWorkerRuntime } from './runtime.js';

const { app, config } = createWorkerRuntime();
try { await app.listen({ host: '0.0.0.0', port: config.PORT }); }
catch { app.log.error({ code: 'STARTUP_FAILED' }, 'Worker failed to start'); await app.close(); process.exitCode = 1; }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
// Parent-owned processes (including smoke tests) can request an orderly close without killing anything.
process.on('message', (message: unknown) => {
  if (message === 'shutdown') void app.close().then(() => { process.disconnect?.(); });
});
