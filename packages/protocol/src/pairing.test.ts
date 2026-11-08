import { describe, it, expect } from 'vitest';
import { encodePairingLink, decodePairingLink, pairingCode, toB64url, randomBytes, generateDeviceKey } from './index.js';

const link = { host: '192.168.1.10:4443', pin: toB64url(randomBytes(32)), token: toB64url(randomBytes(24)), name: 'Home server' };

describe('FR-CLI-03 pairing links', () => {
  it('round-trips', () => {
    expect(decodePairingLink(encodePairingLink(link))).toEqual(link);
  });
  it('accepts IPv6 and hostnames', () => {
    for (const host of ['[fe80::1]:4443', 'my-server.local:4443']) {
      expect(decodePairingLink(encodePairingLink({ ...link, host })).host).toBe(host);
    }
  });
  it('rejects malformed links', () => {
    expect(() => decodePairingLink('https://evil.example/pair?h=x')).toThrow();
    expect(() => decodePairingLink(encodePairingLink(link).replace(/k=[^&]+/, 'k=abc'))).toThrow();
    expect(() => encodePairingLink({ ...link, host: 'nohost' })).toThrow();
    expect(() => encodePairingLink({ ...link, host: 'h:70000' })).toThrow();
  });
});

describe('NFR-SEC-02 pairing code', () => {
  it('is 6 digits, deterministic, and changes with any input', () => {
    const k = generateDeviceKey().publicKey;
    const c = pairingCode(link.pin, k, 'p1');
    expect(c).toMatch(/^\d{6}$/);
    expect(pairingCode(link.pin, k, 'p1')).toBe(c);
    expect(pairingCode(toB64url(randomBytes(32)), k, 'p1')).not.toBe(c);
    expect(pairingCode(link.pin, generateDeviceKey().publicKey, 'p1')).not.toBe(c);
  });
});
