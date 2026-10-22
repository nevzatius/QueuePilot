import { generateKeyPairSync } from 'node:crypto';
import { deleteApp } from 'firebase-admin/app';
import { describe, expect, it } from 'vitest';
import { createFirebaseApp, loadConfig } from '../src/index.js';

// A throwaway key generated at test time: no key material is stored in the repository.
const PROJECT = 'qp-test-project';
const EMAIL = `firebase-adminsdk-fbsvc@${PROJECT}.iam.gserviceaccount.com`;
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keyJson = JSON.stringify({ type: 'service_account', project_id: PROJECT, private_key: privateKey, client_email: EMAIL });
const PROD = {
  QP_ENV: 'production', GCLOUD_PROJECT: PROJECT, QP_WORKER_URL: 'https://qp-worker.example.test', REDIS_URL: 'rediss://default:FAKE@redis.invalid:6380',
  QP_QUEUE_ADAPTER: 'qstash', QSTASH_TOKEN: 'FAKE-t', QSTASH_CURRENT_SIGNING_KEY: 'FAKE-c', QSTASH_NEXT_SIGNING_KEY: 'FAKE-n',
};

describe('createFirebaseApp', () => {
  it('builds a service-account credential for the project when the key is configured', async () => {
    const config = loadConfig({ ...PROD, QP_FIREBASE_SERVICE_ACCOUNT_JSON: keyJson });
    const app = createFirebaseApp(config, 'credential-test-with-key');
    try {
      expect(app.options.projectId).toBe(PROJECT);
      expect(app.options.credential).toMatchObject({ projectId: PROJECT, clientEmail: EMAIL });
    } finally { await deleteApp(app); }
  });

  it('leaves the SDK on ambient credentials when no key is configured', async () => {
    const app = createFirebaseApp(loadConfig(PROD), 'credential-test-without-key');
    try {
      expect(app.options.projectId).toBe(PROJECT);
      expect(app.options.credential).not.toHaveProperty('clientEmail');
    } finally { await deleteApp(app); }
  });
});
