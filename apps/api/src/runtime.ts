import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import {
  AdmissionControl, createDispatchQueue, createLogger, LocalDispatchQueue, startLocalDispatch, FirebaseTokenVerifier, FirestoreMembershipStore,
  FirestoreRequestRepository, loadConfig, MembershipService, MemoryRateLimiter, CachedMetricsService,
  createRedisConnection, ManagedRedis, RedisMetricsCache, RedisQuotaStore, RedisRateLimiter, FirestoreQuotaSubmission,
} from '@queuepilot/core';
import { buildApp } from './app.js';

export function createRuntime() {
  const config = loadConfig();
  const firebase = initializeApp({ projectId: config.GCLOUD_PROJECT }, `api-${randomUUID()}`);
  const db = getFirestore(firebase);
  const clock = { now: () => Date.now() };
  const requests = new FirestoreRequestRepository(db, clock);
  const log = createLogger();
  const redis = new ManagedRedis(config.QP_REDIS_ENABLED
    ? createRedisConnection(config.REDIS_URL, config.QP_REDIS_CONNECT_TIMEOUT_MS) : undefined, clock, config.QP_REDIS_CONNECT_TIMEOUT_MS);
  // Background warm-up: boot never waits for it and a failure changes nothing (requests still fail closed).
  void redis.warm();
  const quota = new RedisQuotaStore(redis, clock, config.QP_REDIS_ENABLED ? config.QP_QUOTA_FAILURE_MODE : 'closed');
  const queue = createDispatchQueue(config, clock, log);
  const app = buildApp({
    config, verifier: new FirebaseTokenVerifier(getAuth(firebase)),
    memberships: new MembershipService(new FirestoreMembershipStore(db), clock, config.QP_MEMBERSHIP_CACHE_TTL * 1000),
    requests, metrics: new CachedMetricsService(requests, clock, new RedisMetricsCache(redis, clock)), queue,
    submission: new FirestoreQuotaSubmission(db, clock, quota, log),
    admission: new AdmissionControl(clock, config.QP_INGEST_RPS_PER_INSTANCE, config.QP_INGEST_MAX_INFLIGHT, config.QP_MAX_BACKLOG),
    rateLimiter: new RedisRateLimiter(redis, clock, config.QP_MAX_INSTANCES, log), bootstrapLimiter: new MemoryRateLimiter(clock, 1),
  });
  const stop = queue instanceof LocalDispatchQueue ? startLocalDispatch(queue, config.QP_WORKER_URL, log) : async () => {};
  app.addHook('onClose', async () => {
    try { await stop(); }
    finally {
      try { await redis.close(); }
      finally { try { await db.terminate(); } finally { await deleteApp(firebase); } }
    }
  });
  return { app, config };
}
