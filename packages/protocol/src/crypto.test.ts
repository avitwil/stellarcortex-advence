import { describe, it, expect } from 'vitest';
import {
  seal, open, deriveKey, randomBytes, utf8, fromUtf8, generateDeviceKey, signRequest, verifyRequest, SIG_HEADERS,
  wrapWithPassphrase, unwrapWithPassphrase, canonicalFrame, sign, verify, toB64url, fromB64url,
} from './index.js';

describe('NFR-SEC-04 XChaCha20-Poly1305 envelopes', () => {
  const key = deriveKey(randomBytes(32), 'test');
  it('round-trips and binds AAD', () => {
    const env = seal(key, utf8('hello'), 'ctx:a');
    expect(fromUtf8(open(key, env, 'ctx:a'))).toBe('hello');
    expect(() => open(key, env, 'ctx:b')).toThrow();
  });
  it('rejects tampering', () => {
    const env = seal(key, utf8('hello'), 'ctx');
    env[env.length - 1]! ^= 1;
    expect(() => open(key, env, 'ctx')).toThrow();
  });
  it('never repeats nonces and hides plaintext', () => {
    const a = seal(key, utf8('same'), 'c');
    const b = seal(key, utf8('same'), 'c');
    expect(toB64url(a)).not.toBe(toB64url(b));
    expect(fromUtf8(a)).not.toContain('same');
  });
  it('derives distinct subkeys per purpose', () => {
    const m = randomBytes(32);
    expect(toB64url(deriveKey(m, 'a'))).not.toBe(toB64url(deriveKey(m, 'b')));
  });
});

describe('NFR-SEC-02 device request signatures', () => {
  const kp = generateDeviceKey();
  const base = { method: 'POST', path: '/v1/x?y=1', body: utf8('{"a":1}'), deviceId: 'dev1', token: 'tok' };
  const parts = (h: Record<string, string>) => ({ ...base, ts: Number(h[SIG_HEADERS.ts]), nonce: h[SIG_HEADERS.nonce]! });
  it('verifies a valid signature', () => {
    const h = signRequest(kp.secretKey, base);
    expect(verifyRequest(kp.publicKey, parts(h), h[SIG_HEADERS.sig]!)).toBe(true);
  });
  it('rejects changes to body, path, token, method or device', () => {
    const h = signRequest(kp.secretKey, base);
    const sig = h[SIG_HEADERS.sig]!;
    expect(verifyRequest(kp.publicKey, { ...parts(h), body: utf8('{"a":2}') }, sig)).toBe(false);
    expect(verifyRequest(kp.publicKey, { ...parts(h), path: '/v1/x?y=2' }, sig)).toBe(false);
    expect(verifyRequest(kp.publicKey, { ...parts(h), token: 'other' }, sig)).toBe(false);
    expect(verifyRequest(kp.publicKey, { ...parts(h), method: 'GET' }, sig)).toBe(false);
    expect(verifyRequest(kp.publicKey, { ...parts(h), deviceId: 'dev2' }, sig)).toBe(false);
  });
  it('rejects another device key and malformed signatures', () => {
    const h = signRequest(kp.secretKey, base);
    expect(verifyRequest(generateDeviceKey().publicKey, parts(h), h[SIG_HEADERS.sig]!)).toBe(false);
    expect(verifyRequest(kp.publicKey, parts(h), 'not-b64!')).toBe(false);
    expect(verifyRequest(kp.publicKey, parts(h), toB64url(new Uint8Array(10)))).toBe(false);
  });
  it('signs websocket frames', () => {
    const f = { deviceId: 'd', ts: 1, nonce: 'n', type: 'chat.send', payload: '{}' };
    const s = sign(kp.secretKey, canonicalFrame(f));
    expect(verify(kp.publicKey, canonicalFrame(f), s)).toBe(true);
    expect(verify(kp.publicKey, canonicalFrame({ ...f, payload: '{"x":1}' }), s)).toBe(false);
  });
});

describe('NFR-SEC-05 passphrase wrapping (Argon2id)', () => {
  const fast = { m: 256, t: 1, p: 1 };
  it('round-trips with the right passphrase only', async () => {
    const secret = randomBytes(32);
    const w = await wrapWithPassphrase(secret, 'correct horse battery', 'master', fast);
    expect(toB64url(await unwrapWithPassphrase(w, 'correct horse battery', 'master'))).toBe(toB64url(secret));
    await expect(unwrapWithPassphrase(w, 'wrong passphrase!', 'master')).rejects.toThrow(/wrong passphrase/);
    await expect(unwrapWithPassphrase(w, 'correct horse battery', 'other')).rejects.toThrow();
    expect(fromB64url(w.salt)).toHaveLength(16);
  });
  it('refuses short passphrases', async () => {
    await expect(wrapWithPassphrase(randomBytes(32), 'short', 'm', fast)).rejects.toThrow();
  });
});
