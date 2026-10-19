import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import type { AppConfig } from '../config';
import { SignInCancelledError, type AuthAdapter } from './AuthContext';

const CANCEL_CODES = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request']);

/** Google is the only provider (ARCHITECTURE §11). Throws if Firebase is not configured. */
export function createFirebaseAdapter(cfg: Pick<AppConfig, 'firebase' | 'authEmulatorUrl'>): AuthAdapter {
  if (!cfg.firebase) throw new Error('Firebase is not configured');
  const auth = getAuth(initializeApp(cfg.firebase));
  if (cfg.authEmulatorUrl) connectAuthEmulator(auth, cfg.authEmulatorUrl, { disableWarnings: true });
  const provider = new GoogleAuthProvider();

  return {
    subscribe(onChange) {
      return onAuthStateChanged(auth, (user) =>
        onChange(user ? { uid: user.uid, email: user.email, displayName: user.displayName } : null),
      );
    },
    async signIn() {
      try {
        await signInWithPopup(auth, provider);
      } catch (e) {
        const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
        if (CANCEL_CODES.has(code)) throw new SignInCancelledError();
        throw e;
      }
    },
    signOut: () => signOut(auth),
    async getIdToken() {
      const user = auth.currentUser;
      if (!user) throw new Error('Not signed in');
      return user.getIdToken();
    },
  };
}
