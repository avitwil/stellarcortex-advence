// XChaCha20-Poly1305 envelopes for data at rest (NFR-SEC-04).
// Format: 0x01 | nonce(24) | ciphertext+tag. AAD binds the envelope to its context
// (for example "secret:google-refresh:<userId>") so ciphertexts cannot be swapped.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes, utf8, concatBytes } from '../encoding.js';

const VERSION = 0x01;
const NONCE_LEN = 24;

export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce, utf8(aad)).encrypt(plaintext);
  return concatBytes(Uint8Array.of(VERSION), nonce, ct);
}

export function open(key: Uint8Array, envelope: Uint8Array, aad: string): Uint8Array {
  if (key.length !== 32) throw new Error('key must be 32 bytes');
  if (envelope.length < 1 + NONCE_LEN + 16 || envelope[0] !== VERSION) {
    throw new Error('invalid envelope');
  }
  const nonce = envelope.subarray(1, 1 + NONCE_LEN);
  const ct = envelope.subarray(1 + NONCE_LEN);
  return xchacha20poly1305(key, nonce, utf8(aad)).decrypt(ct);
}

export function isSealed(data: Uint8Array): boolean {
  return data.length >= 1 + NONCE_LEN + 16 && data[0] === VERSION;
}
