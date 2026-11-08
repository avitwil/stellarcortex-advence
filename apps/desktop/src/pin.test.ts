import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PinStore, spkiPinOfPem, hostnameOf, endpointKey } from './pin';
import { waitForOAuthCode } from './oauth';

function cert(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'c-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', path.join(d, 'k'), '-out', path.join(d, 'c'), '-days', '1', '-subj', '/CN=t'], { stdio: 'ignore' });
  return fs.readFileSync(path.join(d, 'c'), 'utf8');
}

describe('NFR-SEC-01 desktop pinning (main-process pinned agent)', () => {
  const a = cert();
  const b = cert();
  it('stores one pin per endpoint and reports changes', () => {
    const s = new PinStore();
    expect(s.set('192.168.1.5:4443', spkiPinOfPem(a))).toBe(true);
    expect(s.set('192.168.1.5:4443', spkiPinOfPem(a))).toBe(false);
    expect(s.get('192.168.1.5:4443')).toBe(spkiPinOfPem(a));
    expect(s.set('192.168.1.5:4443', spkiPinOfPem(b))).toBe(true);
    expect(s.get('unknown:4443')).toBeUndefined();
  });
  it('keeps separate pins for two servers on one host (different ports)', () => {
    const s = new PinStore();
    s.set('192.168.1.5:4443', spkiPinOfPem(a));
    expect(s.set('192.168.1.5:4444', spkiPinOfPem(b))).toBe(true);
    expect(s.get('192.168.1.5:4443')).toBe(spkiPinOfPem(a));
    expect(s.get('192.168.1.5:4444')).toBe(spkiPinOfPem(b));
    expect(s.get('192.168.1.5')).toBeUndefined();
  });
  it('normalizes endpoints', () => {
    expect(endpointKey('[FE80::1]:4443')).toBe('fe80::1:4443');
    expect(endpointKey('Server.LOCAL')).toBe('server.local:443');
    expect(() => endpointKey('a:b:c')).toThrow();
  });
  it('parses host:port forms', () => {
    expect(hostnameOf('[fe80::1]:4443')).toBe('fe80::1');
    expect(hostnameOf('Server.LOCAL:4443')).toBe('server.local');
  });
  it('rejects malformed pins', () => {
    expect(() => new PinStore().set('h:1', 'short')).toThrow();
  });
});

describe('FR-GGL-02 / FR-MCP-03 desktop loopback receiver', () => {
  it('returns code, state and the full callback (with iss) once and stops listening', async () => {
    const w = waitForOAuthCode({ port: 47999, timeoutMs: 5000 });
    await w.ready;
    const r = await fetch('http://127.0.0.1:47999/oauth/callback?code=abc&state=xyz&iss=https%3A%2F%2Fauth.example');
    expect(r.status).toBe(200);
    expect(await w.result).toEqual({ code: 'abc', state: 'xyz', callbackUrl: 'http://localhost:47823/oauth/callback?code=abc&state=xyz&iss=https%3A%2F%2Fauth.example' });
    await expect(fetch('http://127.0.0.1:47999/oauth/callback?code=x&state=y')).rejects.toThrow();
  });
});
