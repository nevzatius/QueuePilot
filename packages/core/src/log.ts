import { pino } from 'pino';
import type { DestinationStream, LoggerOptions } from 'pino';

/**
 * Redaction is by path, so a secret is covered at the top level and under up to N wildcard levels: `{ config }`,
 * `{ ctx: { config } }`, `{ a: { b: { config } } }` for the config secrets (N = 3), and `{ app }` or `{ options }` for the
 * parsed service-account key that firebase-admin keeps as `privateKey` (N = 5). The convention stays: never log a config
 * or an SDK app on purpose (use redactConfig); this is the safety net for a mistake, and a secret nested deeper is not
 * covered. Each wildcard level costs time per log line (measured here: about 30 us with these paths against about 3.5 us
 * with three plain paths, 100k lines of a small object), which is why the depth is bounded.
 */
const CONFIG_SECRETS = ['QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'REDIS_URL', 'QP_FIREBASE_SERVICE_ACCOUNT_JSON'] as const;
const KEY_FIELDS = ['privateKey', 'private_key'] as const;
const withWildcards = (names: readonly string[], depth: number): string[] =>
  names.flatMap((name) => Array.from({ length: depth + 1 }, (_, levels) => [...Array<string>(levels).fill('*'), name].join('.')));
export const secretPaths = (): string[] => [...withWildcards(CONFIG_SECRETS, 3), ...withWildcards(KEY_FIELDS, 5)];

export const logOptions: LoggerOptions = {
  level: 'info',
  redact: {
    paths: ['authorization', 'cookie', 'cookies', 'description', 'req.headers.authorization',
      'req.headers.cookie', 'headers.authorization', 'headers.cookie', 'body.description',
      'req.body.description', '*.description', '*.authorization', '*.cookies',
      'req.headers["upstash-signature"]', 'headers["upstash-signature"]', '*["upstash-signature"]', '["upstash-signature"]',
      ...secretPaths()],
    censor: '[REDACTED]',
  },
  // Never log raw request URLs, query strings, tokens or bodies.
  serializers: { req: (req: { method?: string }) => ({ method: req.method }) },
};
export const createLogger = (stream?: DestinationStream) => stream ? pino(logOptions, stream) : pino(logOptions);
