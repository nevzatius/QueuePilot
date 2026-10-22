import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@queuepilot/domain';
import type { Config } from '../config.js';

/** Routes QStash calls. The destination URL is `QP_WORKER_URL` + one of these, exactly as the B9-2 adapter publishes it. */
export const WORKER_TASKS_PATH = '/internal/tasks';
export const WORKER_RECONCILE_PATH = '/internal/reconcile';
export type WorkerCaller = 'tasks' | 'scheduler';
const CALLER_PATH: Record<WorkerCaller, string> = { tasks: WORKER_TASKS_PATH, scheduler: WORKER_RECONCILE_PATH };

/**
 * Accepted skew for `exp` and `nbf` between QStash's clock and the worker's. Both run NTP; 30 s absorbs a
 * normal drift without widening a token's life much (QStash tokens are short-lived). Not measured against QStash.
 */
export const QSTASH_CLOCK_TOLERANCE_SECONDS = 30;
/** A real token is a few hundred characters (iss, sub URL, exp, nbf, iat, jti, 43-char body hash). */
export const QSTASH_MAX_TOKEN_CHARS = 1024;

/** Value-free rejection codes; the only thing the worker ever logs about a failed verification. */
export type RejectReason = 'MISSING_HEADER' | 'BAD_FORMAT' | 'BAD_SIGNATURE' | 'BAD_CLAIM' | 'EXPIRED' | 'BODY_MISMATCH';
export type VerifyOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: RejectReason };
export type DeliveryEvidence = { readonly signature: string | undefined; readonly rawBody: Uint8Array };

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const reject = (reason: RejectReason): VerifyOutcome => ({ ok: false, reason });

function decodeJson(segment: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Constant-time check of an HS256 signature (fixed 32-byte digest, so the length comparison leaks nothing). */
function signatureMatches(signingInput: string, signature: Buffer, key: string): boolean {
  const expected = createHmac('sha256', key).update(signingInput).digest();
  return signature.length === expected.length && timingSafeEqual(signature, expected);
}

/**
 * Authenticates a QStash delivery by its `Upstash-Signature` JWT (HS256, signed with the current or next
 * signing key). Pure and synchronous: no IO, so it can run before any SDK client or Firestore access.
 *
 * Replays: `jti` is deliberately not tracked. A replayed delivery is absorbed by idempotency and leases
 * (ADR-017: dispatch is a wake-up, never a correctness signal), and the token expires with `exp` anyway.
 */
export class QStashCallerVerifier {
  /** A rejected delivery is answered 401 (the OIDC verifier keeps 403). */
  readonly rejectStatus = 401;
  // A #private field: util.inspect, JSON.stringify and spreads never show it, so the keys cannot leak by dumping the object.
  readonly #keys: readonly [string, string];
  private readonly subjects: Record<WorkerCaller, string>;

  constructor(config: Pick<Config, 'QP_WORKER_URL' | 'QSTASH_CURRENT_SIGNING_KEY' | 'QSTASH_NEXT_SIGNING_KEY'>,
    private readonly clock: Clock = { now: () => Date.now() }) {
    const { QSTASH_CURRENT_SIGNING_KEY: current, QSTASH_NEXT_SIGNING_KEY: next, QP_WORKER_URL: origin } = config;
    // Constant messages: a value here could be a signing key.
    // loadConfig already rejects surrounding whitespace; repeated here because the HMAC uses the key exactly as given.
    if (!current?.trim() || !next?.trim() || current !== current.trim() || next !== next.trim()) throw new Error('QStash signing keys required');
    if (!URL.canParse(origin) || new URL(origin).origin !== origin) throw new Error('Worker URL must be an origin');
    this.#keys = [current, next];
    // Built from configuration only, never from Host or X-Forwarded-* (a client could forge those).
    this.subjects = { tasks: `${origin}${CALLER_PATH.tasks}`, scheduler: `${origin}${CALLER_PATH.scheduler}` };
  }

  /** CallerVerifier compatibility: a signature cannot be checked without the body, so this never accepts. */
  verify(): Promise<boolean> { return Promise.resolve(false); }

  check(evidence: DeliveryEvidence, caller: WorkerCaller): VerifyOutcome {
    const token = evidence.signature;
    if (token === undefined || token === '') return reject('MISSING_HEADER');
    if (token.length > QSTASH_MAX_TOKEN_CHARS) return reject('BAD_FORMAT');
    const segments = token.split('.');
    if (segments.length !== 3 || !segments.every((segment) => BASE64URL.test(segment))) return reject('BAD_FORMAT');
    const [encodedHeader, encodedPayload, encodedSignature] = segments as [string, string, string];
    const header = decodeJson(encodedHeader);
    const payload = decodeJson(encodedPayload);
    if (header === undefined || payload === undefined) return reject('BAD_FORMAT');
    // Only HS256: `none` and every other algorithm are refused before any key is touched.
    if (header.alg !== 'HS256') return reject('BAD_FORMAT');
    // RFC 7515 4.1.11: a recipient must reject a token whose `crit` extensions it does not understand, and it understands none.
    if (Object.hasOwn(header, 'crit')) return reject('BAD_FORMAT');

    const signature = Buffer.from(encodedSignature, 'base64url');
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    // Current key first, then the next one (rotation). Both are evaluated whatever the first answer is,
    // so the work does not depend on which key signed.
    const currentOk = signatureMatches(signingInput, signature, this.#keys[0]);
    const nextOk = signatureMatches(signingInput, signature, this.#keys[1]);
    if (!currentOk && !nextOk) return reject('BAD_SIGNATURE');

    if (payload.iss !== 'Upstash' || payload.sub !== this.subjects[caller]) return reject('BAD_CLAIM');
    const nowSeconds = this.clock.now() / 1000;
    const { exp, nbf } = payload;
    // `exp` has no upper bound on purpose: only the holder of a signing key can mint a token, and such a holder
    // can already do anything a long-lived token allows. Non-finite values (JSON `1e999` parses to Infinity) are rejected.
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return reject('BAD_CLAIM');
    if (nbf !== undefined && (typeof nbf !== 'number' || !Number.isFinite(nbf))) return reject('BAD_CLAIM');
    // `EXPIRED` covers the whole validity window: past exp, or before nbf.
    if (nowSeconds > exp + QSTASH_CLOCK_TOLERANCE_SECONDS) return reject('EXPIRED');
    if (nbf !== undefined && nowSeconds < nbf - QSTASH_CLOCK_TOLERANCE_SECONDS) return reject('EXPIRED');

    // The hash of the exact bytes received. An empty body hashes as the empty string. QStash's own SDK strips
    // trailing "=" from both sides before comparing, so a padded claim is accepted too.
    if (typeof payload.body !== 'string') return reject('BAD_CLAIM');
    const bodyHash = createHash('sha256').update(evidence.rawBody).digest('base64url');
    const claimed = Buffer.from(payload.body.replace(/=+$/, ''));
    const actual = Buffer.from(bodyHash);
    if (claimed.length !== actual.length || !timingSafeEqual(claimed, actual)) return reject('BODY_MISMATCH');
    return { ok: true };
  }
}
