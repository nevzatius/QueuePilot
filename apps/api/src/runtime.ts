import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import {
  AdmissionControl, deferredQueue, FirebaseTokenVerifier, FirestoreMembershipStore,
  FirestoreRequestRepository, loadConfig, MembershipService, MemoryRateLimiter, MetricsService,
} from '@queuepilot/core';
import { buildApp } from './app.js';

export function createRuntime() {
  const config = loadConfig();
  const firebase = initializeApp({ projectId: config.GCLOUD_PROJECT }, `api-${randomUUID()}`);
  const db = getFirestore(firebase);
  const clock = { now: () => Date.now() };
  const requests = new FirestoreRequestRepository(db, clock);
  const app = buildApp({
    config, verifier: new FirebaseTokenVerifier(getAuth(firebase)),
    memberships: new MembershipService(new FirestoreMembershipStore(db), clock, config.QP_MEMBERSHIP_CACHE_TTL * 1000),
    requests, metrics: new MetricsService(requests, clock), queue: deferredQueue,
    admission: new AdmissionControl(clock, config.QP_INGEST_RPS_PER_INSTANCE, config.QP_INGEST_MAX_INFLIGHT, config.QP_MAX_BACKLOG),
    rateLimiter: new MemoryRateLimiter(clock, config.QP_MAX_INSTANCES), bootstrapLimiter: new MemoryRateLimiter(clock, 1),
  });
  app.log.warn({ code: 'ratelimit.degraded' }, 'B3 uses per-instance burst limits; B5 Redis adapter pending');
  app.log.warn({ code: 'QUEUE_ADAPTER_PENDING' }, 'B4 queue adapter pending; accepted requests remain durable');
  app.addHook('onClose', async () => { await db.terminate(); await deleteApp(firebase); });
  return { app, config };
}
