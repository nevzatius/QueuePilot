import { pino } from 'pino';
import type { DestinationStream, LoggerOptions } from 'pino';

export const logOptions: LoggerOptions = {
  level: 'info',
  redact: {
    paths: ['authorization', 'cookie', 'cookies', 'description', 'req.headers.authorization',
      'req.headers.cookie', 'headers.authorization', 'headers.cookie', 'body.description',
      'req.body.description', '*.description', '*.authorization', '*.cookies',
      'req.headers["upstash-signature"]', 'headers["upstash-signature"]', '*["upstash-signature"]', '["upstash-signature"]',
      'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY', 'REDIS_URL',
      'QP_FIREBASE_SERVICE_ACCOUNT_JSON',
      '*.QSTASH_TOKEN', '*.QSTASH_CURRENT_SIGNING_KEY', '*.QSTASH_NEXT_SIGNING_KEY', '*.REDIS_URL', '*.QP_FIREBASE_SERVICE_ACCOUNT_JSON'],
    censor: '[REDACTED]',
  },
  // Never log raw request URLs, query strings, tokens or bodies.
  serializers: { req: (req: { method?: string }) => ({ method: req.method }) },
};
export const createLogger = (stream?: DestinationStream) => stream ? pino(logOptions, stream) : pino(logOptions);
