import { pino } from 'pino';
import type { DestinationStream, LoggerOptions } from 'pino';

export const logOptions: LoggerOptions = {
  level: 'info',
  redact: {
    paths: ['authorization', 'cookie', 'cookies', 'description', 'req.headers.authorization',
      'req.headers.cookie', 'headers.authorization', 'headers.cookie', 'body.description',
      'req.body.description', '*.description', '*.authorization', '*.cookies'],
    censor: '[REDACTED]',
  },
  // Never log raw request URLs, query strings, tokens or bodies.
  serializers: { req: (req: { method?: string }) => ({ method: req.method }) },
};
export const createLogger = (stream?: DestinationStream) => stream ? pino(logOptions, stream) : pino(logOptions);
