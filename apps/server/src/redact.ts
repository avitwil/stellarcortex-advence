// Secret redaction for every log line and the activity log (NFR-SEC-09).

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bya29\.[0-9A-Za-z._-]{10,}/g,
  /\b1\/\/[0-9A-Za-z_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /("?(?:password|passphrase|secret|client_secret|clientSecret|api[_-]?key|apiKey|token|access_token|refresh_token|authorization)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi,
];

const known = new Set<string>();

/** Register a runtime secret (for example a decrypted API key) for exact-match redaction. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) known.add(value);
}

export function redact(input: string): string {
  let out = input;
  for (const s of known) {
    if (out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (m, g1?: string) => {
      if (typeof g1 === 'string' && m.startsWith(g1)) return `${g1}[REDACTED]`;
      return '[REDACTED]';
    });
  }
  return out;
}

export function redactDeep<T>(value: T): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}
