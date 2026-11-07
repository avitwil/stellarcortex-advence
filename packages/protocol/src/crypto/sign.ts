// Device keys and request signatures (NFR-SEC-02, NFR-SEC-03).
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from './hash.js';
import { toB64url, fromB64url, utf8, randomBytes } from '../encoding.js';

export interface DeviceKeyPair {
  /** 32-byte Ed25519 seed */
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateDeviceKey(): DeviceKeyPair {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function publicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}

export function sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Allowed clock skew for signed requests, in ms. */
export const SIGNATURE_MAX_SKEW_MS = 60_000;

export const SIG_HEADERS = {
  device: 'x-advence-device',
  ts: 'x-advence-ts',
  nonce: 'x-advence-nonce',
  sig: 'x-advence-sig',
} as const;

export interface SignedRequestParts {
  method: string;
  /** path including query string, as sent on the wire */
  path: string;
  body: Uint8Array;
  deviceId: string;
  ts: number;
  nonce: string;
  /** bearer session token, empty string if none */
  token: string;
}

/**
 * Canonical string a device signs. Binds method, path+query, body hash, time, nonce,
 * device and the session token, so a captured signature cannot be replayed on another
 * request or by another device.
 */
export function canonicalRequest(p: SignedRequestParts): Uint8Array {
  return utf8(
    [
      'ADVENCE-REQ-V1',
      p.method.toUpperCase(),
      p.path,
      toB64url(sha256(p.body)),
      String(p.ts),
      p.nonce,
      p.deviceId,
      toB64url(sha256(p.token)),
    ].join('\n'),
  );
}

export function newNonce(): string {
  return toB64url(randomBytes(16));
}

export function signRequest(
  secretKey: Uint8Array,
  p: Omit<SignedRequestParts, 'ts' | 'nonce'> & { ts?: number; nonce?: string },
): Record<string, string> {
  const parts: SignedRequestParts = { ...p, ts: p.ts ?? Date.now(), nonce: p.nonce ?? newNonce() };
  const sig = sign(secretKey, canonicalRequest(parts));
  return {
    [SIG_HEADERS.device]: parts.deviceId,
    [SIG_HEADERS.ts]: String(parts.ts),
    [SIG_HEADERS.nonce]: parts.nonce,
    [SIG_HEADERS.sig]: toB64url(sig),
  };
}

export function verifyRequest(publicKey: Uint8Array, p: SignedRequestParts, sigB64: string): boolean {
  let sig: Uint8Array;
  try {
    sig = fromB64url(sigB64);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return verify(publicKey, canonicalRequest(p), sig);
}

/** Canonical bytes for a signed WebSocket frame. */
export function canonicalFrame(f: { deviceId: string; ts: number; nonce: string; type: string; payload: string }): Uint8Array {
  return utf8(['ADVENCE-WS-V1', f.deviceId, String(f.ts), f.nonce, f.type, toB64url(sha256(f.payload))].join('\n'));
}
