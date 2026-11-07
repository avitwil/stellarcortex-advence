import { randomBytes, toB64url, sha256 } from '@advence/protocol';

export function newId(prefix: string): string {
  return `${prefix}_${toB64url(randomBytes(12))}`;
}

export function newToken(bytes = 32): string {
  return toB64url(randomBytes(bytes));
}

export function hashToken(token: string): string {
  return toB64url(sha256(token));
}
