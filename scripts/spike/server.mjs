import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createClient } from 'redis';

if (process.env.QP_ENV !== 'spike' || !process.env.K_SERVICE?.startsWith('qp-spike-')) {
  throw new Error('Probe handler requires QP_ENV=spike and an isolated qp-spike-* service');
}
if (Object.keys(process.env).some((name) => name.startsWith('QP_FAULT_'))) throw new Error('Fault flags are forbidden');

// Cloud Run IAM authenticates all callers. Only safe Cloud Tasks/Scheduler headers are emitted.
const allowedHeaders = ['x-cloudtasks-taskname', 'x-cloudtasks-queuename', 'x-cloudtasks-taskretrycount',
  'x-cloudtasks-taskexecutioncount', 'x-cloudtasks-tasketa', 'x-cloudscheduler', 'x-cloudscheduler-jobname',
  'x-cloudscheduler-scheduletime'];
let redisBusy = false;
createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (process.env.K_SERVICE === 'qp-spike-hosting' && path !== '/api/auth-header') {
    request.resume(); response.writeHead(404).end(); return;
  }
  const match = /^\/probe\/(success|409|429|fail|delay)\/(spike-[a-z0-9-]{1,100})$/.exec(path);
  const headers = Object.fromEntries(allowedHeaders.filter((h) => request.headers[h] !== undefined).map((h) => [h, request.headers[h]]));
  request.resume(); // Bodies and authorization/cookies are never logged or reflected.
  if (path === '/redis' && request.method === 'POST') {
    if (redisBusy) { response.writeHead(429).end(); return; }
    redisBusy = true;
    let client;
    try {
      if (!process.env.REDIS_URL?.startsWith('rediss://')) throw new Error('TLS Redis is required');
      client = createClient({ url: process.env.REDIS_URL, commandOptions: { timeout: 2000 },
        socket: { connectTimeout: 2000, reconnectStrategy: false } });
      client.on('error', () => {});
      const started = performance.now();
      await client.connect();
      const connectMs = performance.now() - started;
      const samplesMs = [];
      for (let i = 0; i < 20; i++) {
        const before = performance.now();
        if (await client.ping() !== 'PONG') throw new Error('Unexpected PING result');
        samplesMs.push(performance.now() - before);
      }
      const sorted = [...samplesMs].sort((a, b) => a - b);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        connectMs, samplesMs, p50Ms: sorted[9], p95Ms: sorted[18], samples: 20,
        percentileMethod: 'nearest-rank', region: process.env.QP_REGION, revision: process.env.K_REVISION,
      }));
    } catch { response.writeHead(503).end('Redis probe failed'); }
    finally { if (client?.isOpen) client.destroy(); redisBusy = false; }
    return;
  }
  if (path === '/api/auth-header') {
    // Hosting test: return a boolean only. Owner supplies a disposable synthetic bearer value.
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      authorizationForwarded: request.headers.authorization === 'Bearer qp-spike-synthetic',
    }));
    return;
  }
  if (!match) { response.writeHead(404).end(); return; }
  const [, mode, runId] = match;
  if (mode === 'delay') await delay(20000);
  const status = { success: 200, '409': 409, '429': 429, fail: 500, delay: 200 }[mode];
  console.log(JSON.stringify({ at: new Date().toISOString(), runId, status, headers, revision: process.env.K_REVISION }));
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ runId, status }));
}).listen(Number(process.env.PORT ?? 8080), '0.0.0.0', function () {
  // IPC is used only by local isolation tests; Cloud Run has no IPC channel.
  if (process.send) process.send({ port: this.address().port });
});
