import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { utf8 } from '../encoding.js';

export function sha256(data: Uint8Array | string): Uint8Array {
  return nobleSha256(typeof data === 'string' ? utf8(data) : data);
}

/** HKDF-SHA256 subkey derivation with a purpose label (domain separation). */
export function deriveKey(master: Uint8Array, purpose: string, length = 32): Uint8Array {
  if (master.length < 32) throw new Error('master key too short');
  return hkdf(nobleSha256, master, undefined, utf8(`advence/v1/${purpose}`), length);
}
