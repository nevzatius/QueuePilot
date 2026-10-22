import { randomUUID } from 'node:crypto';
import { deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createCallerVerifier, createDispatchQueue, createFirebaseApp, createLogger, FirestoreProcessingStore, loadConfig,
  LocalDispatchQueue, Reconciler, startLocalDispatch, WorkerService } from '@queuepilot/core';
import { buildWorkerApp } from './app.js';

export function createWorkerRuntime() {
  const config = loadConfig();
  const verifier = createCallerVerifier(config); // Fail closed before creating SDK clients.
  const firebase = createFirebaseApp(config, `worker-${randomUUID()}`);
  const db = getFirestore(firebase);
  const clock = { now: () => Date.now() };
  const log = createLogger();
  const store = new FirestoreProcessingStore(db, clock);
  const queue = createDispatchQueue(config, clock, log);
  const app = buildWorkerApp({ verifier, store, worker: new WorkerService(store, log),
    reconciler: new Reconciler(store, queue, clock, log, config.QP_RECONCILER_SHARDS, config.QP_RECONCILE_LIMIT_PER_SHARD) });
  const stop = queue instanceof LocalDispatchQueue ? startLocalDispatch(queue, config.QP_WORKER_URL, log) : async () => {};
  app.addHook('onClose', async () => { await stop(); await db.terminate(); await deleteApp(firebase); });
  return { app, config };
}
