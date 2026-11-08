// Signed releases (D-24, NFR-SEC-10, FR-CLI-05). A release is a manifest (JSON) that lists each
// file with its SHA-256 and size, and a detached Ed25519 signature over a domain-separated copy
// of the manifest's exact bytes. Every install pins the release public key at build time and
// checks the signature, then each file's hash, before anything is applied.
import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from './crypto/hash.js';
import { concatBytes, fromB64url, toB64url, utf8 } from './encoding.js';

export const RELEASE_COMPONENTS = ['server', 'desktop', 'android'] as const;
export type ReleaseComponent = (typeof RELEASE_COMPONENTS)[number];

/** What is signed: this prefix, then the manifest bytes as published. */
export const RELEASE_SIG_DOMAIN = 'stellarcortex-advence release v1\n';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const ReleaseFile = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/),
  /** node's process.platform / process.arch for server bundles; omitted for one-file components */
  platform: z.string().max(20).optional(),
  arch: z.string().max(20).optional(),
  sha256: Hex64,
  size: z.number().int().min(1).max(4 * 1024 ** 3),
});
export type ReleaseFile = z.infer<typeof ReleaseFile>;

export const ReleaseManifest = z.object({
  product: z.literal('stellarcortex-advence'),
  component: z.enum(RELEASE_COMPONENTS),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  /** Android versionCode, so the app can compare without parsing names */
  versionCode: z.number().int().min(1).optional(),
  /** server bundles: the Node.js release their native modules were built for */
  runtime: z.string().regex(/^v\d+\.\d+\.\d+$/).optional(),
  createdAt: z.string(),
  notes: z.string().max(4000).default(''),
  files: z.array(ReleaseFile).min(1).max(50),
}); // unknown fields are dropped, so older installs can read newer manifests
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

export class ReleaseError extends Error {
  constructor(public code: 'bad_signature' | 'bad_manifest' | 'wrong_component' | 'bad_hash' | 'no_key' | 'no_file', message?: string) {
    super(message ?? code);
  }
}

const signed = (manifest: Uint8Array) => concatBytes(utf8(RELEASE_SIG_DOMAIN), manifest);

/** Signs manifest bytes with a 32-byte Ed25519 seed (release tooling only). */
export function signRelease(secretKey: Uint8Array, manifest: Uint8Array): string {
  return toB64url(ed25519.sign(signed(manifest), secretKey));
}

export function releasePublicKey(secretKey: Uint8Array): string {
  return toB64url(ed25519.getPublicKey(secretKey));
}

/**
 * Checks the signature against any of the pinned keys (a key rotation ships the new key in a
 * release signed by the old one), then parses the manifest. Throws ReleaseError.
 */
export function verifyRelease(manifest: Uint8Array, signature: string, pinnedKeys: string[], component: ReleaseComponent): ReleaseManifest {
  const keys = pinnedKeys.map((k) => k.trim()).filter(Boolean);
  if (!keys.length) throw new ReleaseError('no_key', 'no release key is pinned in this build');
  let sig: Uint8Array;
  try {
    sig = fromB64url(signature.trim());
  } catch {
    throw new ReleaseError('bad_signature');
  }
  const msg = signed(manifest);
  const ok = keys.some((k) => {
    try {
      return ed25519.verify(sig, msg, fromB64url(k));
    } catch {
      return false;
    }
  });
  if (!ok) throw new ReleaseError('bad_signature');
  let m: ReleaseManifest;
  try {
    m = ReleaseManifest.parse(JSON.parse(new TextDecoder().decode(manifest)));
  } catch {
    throw new ReleaseError('bad_manifest');
  }
  if (m.component !== component) throw new ReleaseError('wrong_component');
  return m;
}

export function sha256Hex(data: Uint8Array): string {
  return [...sha256(data)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when the downloaded bytes are the file the manifest lists. */
export function fileMatches(f: ReleaseFile, data: Uint8Array): boolean {
  return data.length === f.size && sha256Hex(data) === f.sha256;
}

/** Compares x.y.z[-pre] versions; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = '', pre] = v.split('-', 2);
    return { n: main.split('.').map((x) => Number(x) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) - (y.n[i] ?? 0);
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}
