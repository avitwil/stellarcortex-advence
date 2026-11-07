// Deterministic write guard (FR-LRN-02): every memory or skill write from a Bot is checked
// against name rules, size limits, duplicates, a do-not-capture list and folder ownership
// before it reaches the vault. Rejections are returned to the Bot and logged.

export class GuardError extends Error {
  constructor(readonly rule: 'name' | 'size' | 'duplicate' | 'do_not_capture' | 'ownership' | 'format', message: string) {
    super(message);
  }
}

export const NOTE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.()-]{0,79}$/u;
/** Agent Skills names: 1-64 chars, a-z 0-9 and single hyphens, not at either end. */
export const SKILL_NAME = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
export const MAX_NOTE_CHARS = 20_000;
export const MAX_SKILL_LINES = 500;

/** Secrets, tokens and personal data of other people that must never be captured. */
const DO_NOT_CAPTURE: { what: string; re: RegExp }[] = [
  { what: 'an API key', re: /\b(sk-(ant-|proj-)?[A-Za-z0-9_-]{16,}|sk_(live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/ },
  { what: 'a private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { what: 'a token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(bearer|token|api[_-]?key|secret|password|passwd|pwd)\s*[:=]\s*\S{6,}/i },
  { what: 'a payment card number', re: /\b(?:\d[ -]?){13,19}\b/ },
  { what: 'a bank account number', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/ },
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?:\+|\b0)\d[\d\s().-]{7,}\d\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Throws when the text holds something on the do-not-capture list. The owner's own email may
 * appear anywhere; phone numbers only in the owner's own folder (`user/`).
 */
export function checkCapture(text: string, o: { ownerEmail: string; scope: 'agent' | 'shared' | 'user' | 'skill' }): void {
  for (const r of DO_NOT_CAPTURE) {
    const m = r.re.exec(text);
    if (!m) continue;
    if (r.what === 'a payment card number' && !luhn(m[0].replace(/\D/g, ''))) continue;
    throw new GuardError('do_not_capture', `Not saved: it contains ${r.what}. Secrets and other people's personal data are never stored in memory.`);
  }
  for (const e of text.match(EMAIL) ?? []) {
    if (e.toLowerCase() !== o.ownerEmail.toLowerCase()) throw new GuardError('do_not_capture', 'Not saved: it contains another person\'s email address.');
  }
  if (o.scope !== 'user' && PHONE.test(text)) {
    PHONE.lastIndex = 0;
    throw new GuardError('do_not_capture', 'Not saved: it contains a phone number. Only facts about the owner go in the user folder.');
  }
  PHONE.lastIndex = 0;
}

const words = (s: string) => new Set(s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));

/** Word-set similarity, 0..1. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** A new note or skill must not repeat an existing one; patch that one instead. */
export function checkDuplicate(name: string, body: string, existing: { name: string; body: string }[]): void {
  for (const e of existing) {
    if (e.name === name) continue; // same note: an update
    if (e.name.toLowerCase() === name.toLowerCase()) throw new GuardError('duplicate', `"${e.name}" already exists with another spelling. Update it instead.`);
    if (body.length > 40 && similarity(body, e.body) >= 0.85) throw new GuardError('duplicate', `This repeats "${e.name}". Update that one instead of adding a copy.`);
  }
}

export function checkNoteName(name: string): void {
  if (!NOTE_NAME.test(name) || name.toUpperCase() === 'MEMORY') throw new GuardError('name', 'Note names use letters, digits, spaces and - _ . ( ), up to 80 characters, and are not "MEMORY".');
}

export function checkSize(text: string, kind: 'note' | 'skill'): void {
  if (kind === 'note' && text.length > MAX_NOTE_CHARS) throw new GuardError('size', `Notes are limited to ${MAX_NOTE_CHARS} characters. Split it into linked notes.`);
  if (kind === 'skill' && text.split('\n').length >= MAX_SKILL_LINES) throw new GuardError('size', `A skill body must stay under ${MAX_SKILL_LINES} lines. Move details to references/.`);
}
