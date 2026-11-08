// Release tooling (D-24, NFR-SEC-10). Uses node:crypto only, so it runs before anything is built.
// The format matches packages/protocol/src/release.ts: an Ed25519 signature over
// RELEASE_SIG_DOMAIN + the manifest's exact bytes, base64url.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DOMAIN = 'stellarcortex-advence release v1\n';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function privateKeyFromSeed(seed) {
  if (seed.length !== 32) throw new Error('the release key must be a 32-byte Ed25519 seed');
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function publicKeyOf(priv) {
  return crypto.createPublicKey(priv).export({ format: 'jwk' }).x;
}

/** The seed from ADVENCE_RELEASE_KEY (base64url) or a key file; never printed. */
export function loadSeed(keyFile) {
  const text = keyFile ? fs.readFileSync(keyFile, 'utf8') : process.env.ADVENCE_RELEASE_KEY ?? '';
  const seed = Buffer.from(text.trim(), 'base64url');
  if (seed.length !== 32) throw new Error('no release key: set ADVENCE_RELEASE_KEY or pass --key-file');
  return seed;
}

export function sign(seed, manifestBytes) {
  return crypto.sign(null, Buffer.concat([Buffer.from(DOMAIN), manifestBytes]), privateKeyFromSeed(seed)).toString('base64url');
}

export function verify(pub, manifestBytes, sig) {
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' });
  return crypto.verify(null, Buffer.concat([Buffer.from(DOMAIN), manifestBytes]), key, Buffer.from(sig.trim(), 'base64url'));
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

export const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
