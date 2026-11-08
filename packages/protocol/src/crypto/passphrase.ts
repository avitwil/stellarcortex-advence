// Passphrase key wrapping with Argon2id (NFR-SEC-04 fallback, NFR-SEC-05 backups).
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { seal, open } from './aead.js';
import { randomBytes, toB64url, fromB64url, utf8 } from '../encoding.js';

export interface Argon2Params {
  /** memory in KiB */
  m: number;
  t: number;
  p: number;
}

/** Defaults follow OWASP guidance for Argon2id (m=64 MiB, t=3, p=1). */
export const DEFAULT_ARGON2: Argon2Params = { m: 65536, t: 3, p: 1 };

export interface WrappedKey {
  v: 1;
  kdf: 'argon2id';
  params: Argon2Params;
  salt: string;
  /** sealed key, base64url */
  data: string;
}

export async function passphraseKey(passphrase: string, salt: Uint8Array, params: Argon2Params): Promise<Uint8Array> {
  if (passphrase.length < 8) throw new Error('passphrase too short');
  return argon2idAsync(utf8(passphrase), salt, { ...params, dkLen: 32 });
}

export async function wrapWithPassphrase(
  secret: Uint8Array,
  passphrase: string,
  purpose: string,
  params: Argon2Params = DEFAULT_ARGON2,
): Promise<WrappedKey> {
  const salt = randomBytes(16);
  const k = await passphraseKey(passphrase, salt, params);
  return { v: 1, kdf: 'argon2id', params, salt: toB64url(salt), data: toB64url(seal(k, secret, `wrap:${purpose}`)) };
}

export async function unwrapWithPassphrase(w: WrappedKey, passphrase: string, purpose: string): Promise<Uint8Array> {
  if (w.v !== 1 || w.kdf !== 'argon2id') throw new Error('unsupported wrap format');
  const k = await passphraseKey(passphrase, fromB64url(w.salt), w.params);
  try {
    return open(k, fromB64url(w.data), `wrap:${purpose}`);
  } catch {
    throw new Error('wrong passphrase or corrupted data');
  }
}
