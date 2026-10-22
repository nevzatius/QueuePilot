import type { Clock } from '@queuepilot/domain';
import type { Config } from '../config.js';
import { QStashCallerVerifier } from './qstash-auth.js';
import type { DeliveryEvidence, VerifyOutcome, WorkerCaller } from './qstash-auth.js';

export interface CallerVerifier { verify(authorization: string | undefined, caller: WorkerCaller): Promise<boolean> }
/**
 * A verifier that authenticates the delivery itself (signature over the raw body) instead of a bearer token.
 * The worker keeps the raw bytes for its routes, calls `check` before parsing, and answers `rejectStatus`.
 */
export interface DeliveryVerifier extends CallerVerifier {
  readonly rejectStatus: 401;
  check(evidence: DeliveryEvidence, caller: WorkerCaller): VerifyOutcome;
}
export const isDeliveryVerifier = (verifier: CallerVerifier): verifier is DeliveryVerifier => 'check' in verifier && typeof verifier.check === 'function';
type Claims = { email?: string; email_verified?: boolean; iss?: string; aud?: string };
export type VerifyIdToken = (token: string, audience: string) => Promise<Claims | undefined>;
let googleVerifier: Promise<import('google-auth-library').OAuth2Client> | undefined;
const verifyGoogleToken: VerifyIdToken = async (token, audience) => {
  googleVerifier ??= import('google-auth-library').then(({ OAuth2Client }) => new OAuth2Client());
  return (await (await googleVerifier).verifyIdToken({ idToken: token, audience })).getPayload();
};

export class OidcCallerVerifier implements CallerVerifier {
  constructor(private readonly config: Config, private readonly verifyToken: VerifyIdToken = verifyGoogleToken) {
    if (!config.QP_TASKS_OIDC_AUDIENCE || !config.QP_TASKS_INVOKER_SA) throw new Error('OIDC audience and caller required');
  }
  async verify(authorization: string | undefined, caller: WorkerCaller) {
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) return false;
    try {
      const audience = this.config.QP_TASKS_OIDC_AUDIENCE!;
      const claims = await this.verifyToken(authorization.slice(7), audience);
      const email = caller === 'tasks' ? this.config.QP_TASKS_INVOKER_SA
        : this.config.QP_SCHEDULER_SA ?? `qp-scheduler-sa@${this.config.GCLOUD_PROJECT}.iam.gserviceaccount.com`;
      return claims !== undefined && claims.email === email && claims.email_verified === true && claims.aud === audience
        && (claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com');
    } catch { return false; }
  }
}

export function createCallerVerifier(config: Config, clock?: Clock): CallerVerifier {
  if (config.QP_WORKER_AUTH_MODE === 'qstash') {
    // Defence in depth when a manually constructed Config bypasses loadConfig: the OIDC settings are not needed here.
    if (config.QP_QUEUE_ADAPTER !== 'qstash') throw new Error('Worker auth mode does not match the queue backend');
    return new QStashCallerVerifier(config, clock);
  }
  if (config.QP_WORKER_AUTH_MODE !== 'local') return new OidcCallerVerifier(config);
  // Defence in depth when a manually constructed Config bypasses loadConfig.
  if (config.QP_ENV === 'production' || config.QP_QUEUE_ADAPTER !== 'local' || !config.GCLOUD_PROJECT.startsWith('demo-')
      || !/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) {
    throw new Error('Unsafe local authentication configuration');
  }
  return { verify: async () => true };
}
