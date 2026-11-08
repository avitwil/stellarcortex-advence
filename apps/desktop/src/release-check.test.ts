// FR-CLI-05 / NFR-SEC-10 (desktop): a downloaded installer is accepted only when it matches the
// signed release manifest; a tampered installer or manifest is rejected before install.
import { describe, expect, it } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import { releasePublicKey, signRelease } from '@advence/protocol';
import { checkDownloadedUpdate, fetchLimited, installerFor } from './release-check';

const seed = randomBytes(32);
const key = releasePublicKey(seed);
const installer = new Uint8Array(randomBytes(4096));
const files = [
  { name: 'StellarCortex-Advence-Setup-1.1.0.exe', sha256: createHash('sha256').update(installer).digest('hex'), size: installer.length },
  { name: 'StellarCortex-Advence-1.1.0-universal.dmg', sha256: 'a'.repeat(64), size: 10 },
  { name: 'StellarCortex-Advence-1.1.0.AppImage', sha256: 'b'.repeat(64), size: 10 },
];
const manifestOf = (o: Record<string, unknown> = {}) => new TextEncoder().encode(JSON.stringify({ product: 'stellarcortex-advence', component: 'desktop', version: '1.1.0', createdAt: '2026-11-08T00:00:00Z', notes: '', files, ...o }));
const base = (o: Partial<Parameters<typeof checkDownloadedUpdate>[0]> = {}) => {
  const manifest = o.manifest ?? manifestOf();
  return { manifest, signature: signRelease(seed, manifest), keys: [key], version: '1.1.0', current: '1.0.0', file: installer, ...o };
};

describe('FR-CLI-05 desktop: downloaded update is checked against the signed manifest', () => {
  it('accepts the signed installer', () => {
    expect(checkDownloadedUpdate(base()).file.name).toBe(files[0]!.name);
  });
  it('rejects a tampered installer', () => {
    const evil = installer.slice();
    evil[0] = evil[0]! ^ 1;
    expect(() => checkDownloadedUpdate(base({ file: evil }))).toThrow(expect.objectContaining({ code: 'bad_hash' }));
  });
  it('rejects a manifest signed by another key, edited after signing, or for another component', () => {
    const b = base();
    expect(() => checkDownloadedUpdate({ ...b, signature: signRelease(randomBytes(32), b.manifest) })).toThrow(expect.objectContaining({ code: 'bad_signature' }));
    expect(() => checkDownloadedUpdate({ ...b, manifest: manifestOf({ notes: 'edited' }) })).toThrow(expect.objectContaining({ code: 'bad_signature' }));
    const server = manifestOf({ component: 'server' });
    expect(() => checkDownloadedUpdate(base({ manifest: server, signature: signRelease(seed, server) }))).toThrow(expect.objectContaining({ code: 'wrong_component' }));
  });
  it('rejects a version mismatch, a downgrade and a build without a pinned key', () => {
    expect(() => checkDownloadedUpdate(base({ version: '1.2.0' }))).toThrow(expect.objectContaining({ code: 'bad_manifest' }));
    expect(() => checkDownloadedUpdate(base({ current: '1.1.0' }))).toThrow(expect.objectContaining({ code: 'bad_manifest' }));
    expect(() => checkDownloadedUpdate(base({ keys: [] }))).toThrow(expect.objectContaining({ code: 'no_key' }));
  });
  it('picks the installer for each platform', () => {
    expect(installerFor(files, 'darwin')?.name).toMatch(/\.dmg$/);
    expect(installerFor(files, 'win32')?.name).toMatch(/\.exe$/);
    expect(installerFor(files, 'linux')?.name).toMatch(/\.AppImage$/);
  });
});

describe('fetchLimited (FR-CLI-05)', () => {
  const streaming = (chunks: number, size: number) => (async () => new Response(new ReadableStream({
    start(c) {
      for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(size));
      c.close();
    },
  }))) as unknown as typeof fetch;
  it('stops reading a response without a length once it passes the limit', async () => {
    await expect(fetchLimited(streaming(100, 1024), 'https://feed.test/x', 10 * 1024)).rejects.toThrow('too large');
    expect((await fetchLimited(streaming(4, 1024), 'https://feed.test/x', 10 * 1024)).length).toBe(4096);
  });
  it('refuses a declared length over the limit', async () => {
    const f = (async () => new Response('x', { headers: { 'content-length': '999999' } })) as unknown as typeof fetch;
    await expect(fetchLimited(f, 'https://feed.test/x', 10)).rejects.toThrow('too large');
  });
});
