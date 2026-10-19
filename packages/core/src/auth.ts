import type { Auth } from 'firebase-admin/auth';
import { UidSchema } from '@queuepilot/contracts';
import { ApiError } from './errors.js';

export interface TokenVerifier {
  verify(token: string): Promise<{ uid: string; email: string | null }>;
}

export class FirebaseTokenVerifier implements TokenVerifier {
  constructor(private readonly auth: Auth) {}
  async verify(token: string) {
    let decoded;
    try { decoded = await this.auth.verifyIdToken(token, false); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (code?.startsWith('auth/') && !['auth/internal-error', 'auth/network-request-failed'].includes(code)) {
        throw new ApiError('UNAUTHENTICATED');
      }
      throw new ApiError('SERVICE_UNAVAILABLE', 1);
    }
    if (!UidSchema.safeParse(decoded.uid).success || decoded.uid.includes('/') ||
      decoded.email_verified !== true || decoded.firebase.sign_in_provider !== 'google.com') {
      throw new ApiError('UNAUTHENTICATED');
    }
    return { uid: decoded.uid, email: decoded.email ?? null };
  }
}

export function bearerToken(header: string | undefined): string {
  const match = /^Bearer ([^\s]{1,16384})$/i.exec(header ?? '');
  if (!match?.[1]) throw new ApiError('UNAUTHENTICATED');
  return match[1];
}
