import pino, { type Logger } from 'pino';
import { redact } from './redact.js';

/** All log output passes through redact() before it is written (NFR-SEC-09). */
export function createLogger(level = process.env.ADVENCE_LOG_LEVEL ?? 'info', sink: (line: string) => void = (l) => process.stdout.write(l)): Logger {
  return pino(
    {
      level,
      redact: { paths: ['req.headers.authorization', 'req.headers["x-advence-sig"]', '*.token', '*.secret', '*.password'], censor: '[REDACTED]' },
      base: undefined,
    },
    { write: (line: string) => sink(redact(line)) },
  );
}

export type { Logger };
