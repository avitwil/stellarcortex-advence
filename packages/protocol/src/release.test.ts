// NFR-SEC-10 / FR-CLI-05: release manifests are verified against the pinned Ed25519 key before
// anything is applied; a tampered manifest or file, or another key, is rejected.
import { describe, it, expect } from 'vitest';
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import { compareVersions, fileMatches, randomBytes, releasePublicKey, ReleaseError, RELEASE_SIG_DOMAIN, signRelease, utf8, verifyRelease, sha256Hex, fromB64url } from './index.js';

const key = randomBytes(32);
const pub = releasePublicKey(key);
const bundle = utf8('server bundle bytes');
const manifest = utf8(JSON.stringify({
  product: 'stellarcortex-advence', component: 'server', version: '1.2.0', createdAt: '2026-11-08T00:00:00Z', notes: '',
  files: [{ name: 'advence-server-1.2.0-linux-x64.tar.gz', platform: 'linux', arch: 'x64', sha256: sha256Hex(bundle), size: bundle.length }],
}));

describe('NFR-SEC-10 release signature verify step', () => {
  it('accepts a manifest signed by the pinned key and checks each file', () => {
    const sig = signRelease(key, manifest);
    const m = verifyRelease(manifest, sig, [pub], 'server');
    expect(m.version).toBe('1.2.0');
    expect(fileMatches(m.files[0]!, bundle)).toBe(true);
    expect(fileMatches(m.files[0]!, utf8('server bundle bytez'))).toBe(false);
  });

  it('rejects a tampered manifest, another key, the wrong component and no pinned key', () => {
    const sig = signRelease(key, manifest);
    const tampered = utf8(new TextDecoder().decode(manifest).replace('1.2.0', '9.9.9'));
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as ReleaseError).code;
      }
      return 'accepted';
    };
    expect(code(() => verifyRelease(tampered, sig, [pub], 'server'))).toBe('bad_signature');
    expect(code(() => verifyRelease(manifest, sig, [releasePublicKey(randomBytes(32))], 'server'))).toBe('bad_signature');
    expect(code(() => verifyRelease(manifest, sig, [pub], 'desktop'))).toBe('wrong_component');
    expect(code(() => verifyRelease(manifest, sig, [], 'server'))).toBe('no_key');
    expect(code(() => verifyRelease(manifest, 'not-a-signature', [pub], 'server'))).toBe('bad_signature');
    // A rotated key: either pinned key is accepted.
    expect(verifyRelease(manifest, sig, [releasePublicKey(randomBytes(32)), pub], 'server').version).toBe('1.2.0');
  });

  it('matches what the installers check with node:crypto', () => {
    const sig = signRelease(key, manifest);
    const k = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' });
    const msg = Buffer.concat([Buffer.from(RELEASE_SIG_DOMAIN), Buffer.from(manifest)]);
    expect(nodeVerify(null, msg, k, Buffer.from(fromB64url(sig)))).toBe(true);
  });

  it('compares versions with pre-releases first', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-alpha.9')).toBeGreaterThan(0);
  });
});
