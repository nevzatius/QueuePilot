import { cert, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { configuredServiceAccount } from './config.js';
import type { Config } from './config.js';

/**
 * The single place a Firebase Admin app is created. With QP_FIREBASE_SERVICE_ACCOUNT_JSON the credential is built
 * from that key; without it the SDK uses application default credentials (Cloud Run metadata, the emulator, or
 * GOOGLE_APPLICATION_CREDENTIALS). ID-token verification needs only the project ID; Firestore needs the credential.
 */
export function createFirebaseApp(config: Pick<Config, 'GCLOUD_PROJECT' | 'QP_FIREBASE_SERVICE_ACCOUNT_JSON'>, name: string): App {
  const account = configuredServiceAccount(config);
  return initializeApp({ projectId: config.GCLOUD_PROJECT, ...(account ? { credential: cert(account) } : {}) }, name);
}
