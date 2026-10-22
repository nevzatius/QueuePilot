import { configWarnings } from '@queuepilot/core';
import { createRuntime } from './runtime.js';

const { app, config } = createRuntime();
for (const warning of configWarnings(config)) app.log.warn({ code: 'CONFIG_WARNING' }, warning);
try { await app.listen({ host: '0.0.0.0', port: config.PORT }); }
catch { app.log.error({ code: 'STARTUP_FAILED' }, 'API failed to start'); await app.close(); process.exitCode = 1; }
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
