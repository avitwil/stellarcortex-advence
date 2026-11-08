// Pairing links and codes (FR-CLI-03, NFR-SEC-01, NFR-SEC-02).
import { sha256 } from './crypto/hash.js';
import { toB64url, fromB64url, concatBytes, utf8 } from './encoding.js';

export const PAIR_SCHEME = 'advence:';

export interface PairingLink {
  /** host:port the client connects to */
  host: string;
  /** SHA-256 of the server certificate's SubjectPublicKeyInfo (DER), base64url */
  pin: string;
  /** one-time pairing token */
  token: string;
  /** display name of the server */
  name: string;
}

const HOST_RE = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;

export function encodePairingLink(l: PairingLink): string {
  validate(l);
  const q = new URLSearchParams({ h: l.host, k: l.pin, t: l.token, n: l.name });
  return `${PAIR_SCHEME}//pair?${q.toString()}`;
}

export function decodePairingLink(s: string): PairingLink {
  const trimmed = s.trim();
  if (!trimmed.startsWith(`${PAIR_SCHEME}//pair?`)) throw new Error('not a pairing link');
  const q = new URLSearchParams(trimmed.slice(`${PAIR_SCHEME}//pair?`.length));
  const l: PairingLink = { host: q.get('h') ?? '', pin: q.get('k') ?? '', token: q.get('t') ?? '', name: q.get('n') ?? '' };
  validate(l);
  return l;
}

function validate(l: PairingLink): void {
  const m = HOST_RE.exec(l.host);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) throw new Error('invalid host');
  if (fromB64url(l.pin).length !== 32) throw new Error('invalid pin');
  if (fromB64url(l.token).length < 16) throw new Error('invalid token');
  if (l.name.length < 1 || l.name.length > 64) throw new Error('invalid name');
}

/**
 * 6-digit confirmation code shown on both the new device and the approving side.
 * It binds the pinned server key, the device public key and the pairing session, so a
 * man in the middle produces a different code on each side.
 */
export function pairingCode(serverPin: string, devicePublicKey: Uint8Array, pairingId: string): string {
  const h = sha256(concatBytes(utf8('ADVENCE-PAIR-V1'), fromB64url(serverPin), devicePublicKey, utf8(pairingId)));
  const n = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

export function spkiPin(spkiDer: Uint8Array): string {
  return toB64url(sha256(spkiDer));
}
