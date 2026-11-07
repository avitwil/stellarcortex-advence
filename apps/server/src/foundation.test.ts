import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { startTestServer, pairedClient, ownerClient, configureGoogle, TestClient, type TestEnv, CLIENT_ID, pinOfPem } from './test-utils/harness.js';
import { toB64url, randomBytes } from '@advence/protocol';
import { SESSION_TTL_MS } from './auth/identity.js';

let env: TestEnv;
beforeAll(async () => {
  env = await startTestServer();
});
afterAll(async () => {
  await env.close();
});
const port = () => Number(new URL(env.server.url).port);

describe('NFR-SEC-01 transport', () => {
  it('serves TLS 1.3 only', async () => {
    const tls12 = await new Promise<string>((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: port(), maxVersion: 'TLSv1.2', rejectUnauthorized: false });
      s.once('secureConnect', () => { resolve('connected'); s.destroy(); });
      s.once('error', () => resolve('refused'));
    });
    expect(tls12).toBe('refused');
    const v = await new Promise<string | null>((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: port(), rejectUnauthorized: false });
      s.once('secureConnect', () => { resolve(s.getProtocol()); s.destroy(); });
      s.once('error', () => resolve(null));
    });
    expect(v).toBe('TLSv1.3');
  });
  it('a client pinned to another key refuses the connection (MITM test)', async () => {
    const c = new TestClient(env.server.url, toB64url(randomBytes(32)));
    await expect(c.request('GET', '/v1/health')).rejects.toThrow('pin_mismatch');
  });
  it('pinned client connects and the pin matches the served certificate', async () => {
    const c = new TestClient(env.server.url, env.server.ctx.tls.pin);
    expect(pinOfPem(env.server.ctx.tls.certPem)).toBe(env.server.ctx.tls.pin);
    const r = await c.request('GET', '/v1/health');
    expect(r.status).toBe(200);
  });
  it('plain HTTP is not served', async () => {
    await expect(fetch(`http://127.0.0.1:${port()}/v1/health`)).rejects.toThrow();
  });
});

describe('FR-CLI-03 / NFR-SEC-02 pairing', () => {
  it('pairs via link, shows the same code on both sides, and requires the typed code', async () => {
    const link = env.server.ctx.identity.createPairingToken(null, `127.0.0.1:${port()}`, 'Srv').link;
    const c = TestClient.fromLink(link, port());
    const { pairingId, code } = await c.pair(link);
    const pending = env.server.ctx.identity.pendingPairings();
    expect(pending.find((p) => p.pairingId === pairingId)?.code).toBe(code);
    expect((await c.request('GET', `/v1/pair/status/${pairingId}`)).json.status).toBe('pending');
    const wrong = code === '000000' ? '111111' : '000000';
    expect(() => env.server.ctx.identity.approvePairing(pairingId, wrong)).toThrow();
    env.server.ctx.identity.approvePairing(pairingId, code);
    expect((await c.request('GET', `/v1/pair/status/${pairingId}`)).json.status).toBe('approved');
  });
  it('a pairing token is single-use', async () => {
    const link = env.server.ctx.identity.createPairingToken(null, `127.0.0.1:${port()}`, 'Srv').link;
    await TestClient.fromLink(link, port()).pair(link);
    await expect(TestClient.fromLink(link, port()).pair(link)).rejects.toThrow(/400/);
  });
  it('five wrong codes reject the pairing and revoke the device', async () => {
    const link = env.server.ctx.identity.createPairingToken(null, `127.0.0.1:${port()}`, 'Srv').link;
    const c = TestClient.fromLink(link, port());
    const { pairingId, code } = await c.pair(link);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(() => env.server.ctx.identity.approvePairing(pairingId, wrong)).toThrow();
    expect(() => env.server.ctx.identity.approvePairing(pairingId, code)).toThrow();
    expect((await c.request('GET', `/v1/pair/status/${pairingId}`)).status).toBe(403);
  });
  it('a pending device cannot call device routes', async () => {
    const link = env.server.ctx.identity.createPairingToken(null, `127.0.0.1:${port()}`, 'Srv').link;
    const c = TestClient.fromLink(link, port());
    await c.pair(link);
    expect((await c.request('GET', '/v1/setup')).status).toBe(401);
  });
});

describe('FR-GGL-01/02/03 setup wizard and Google login', () => {
  let owner: TestClient;
  it('setup is open to the first paired device, and login makes the first account owner', async () => {
    const c = await pairedClient(env);
    const info = await c.request('GET', '/v1/setup');
    expect(info.status).toBe(200);
    expect(info.json.webRedirectUri).toBe('http://localhost:47823/oauth/callback');
    expect(info.json.androidPackage).toBe('com.stellarcortex.advence');
    expect((await c.request('POST', '/v1/setup/google', { clientId: 'bad', clientSecret: 'x' })).status).toBe(400);
    await configureGoogle(c);
    const r = await c.loginWithCode(env.google, { sub: 'owner-sub', email: 'owner@example.com' });
    expect(r.status).toBe(200);
    expect(r.json.user.role).toBe('owner');
    expect(r.json.expiresAt - Date.now()).toBeLessThanOrEqual(SESSION_TTL_MS);
    expect(env.google.lastTokenRequest?.get('code_verifier')).toBeTruthy();
    owner = c;
  });
  it('the auth URL uses PKCE S256, state and the Web client ID', async () => {
    const r = await owner.request('POST', '/v1/auth/google/start', { codeChallenge: toB64url(randomBytes(32)), redirectUri: 'http://localhost:47823/oauth/callback' });
    const u = new URL(r.json.url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('state')).toBe(r.json.state);
    expect((await owner.request('POST', '/v1/auth/google/start', { codeChallenge: toB64url(randomBytes(32)), redirectUri: 'http://evil.example/cb' })).status).toBe(400);
  });
  it('after an owner exists, setup needs the owner', async () => {
    const c = await pairedClient(env);
    expect((await c.request('GET', '/v1/setup')).status).toBe(401);
    expect((await owner.request('GET', '/v1/setup')).status).toBe(200);
  });
  it('an unlisted Google account gets 403', async () => {
    const c = await pairedClient(env);
    const r = await c.loginWithCode(env.google, { sub: 'stranger', email: 'stranger@example.com' });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('not_allowlisted');
  });
  it('an allowlisted account logs in as member; unverified email is refused', async () => {
    expect((await owner.request('POST', '/v1/allowlist', { email: 'friend@example.com' })).status).toBe(200);
    const c = await pairedClient(env);
    expect((await c.loginWithCode(env.google, { sub: 'friend-sub', email: 'friend@example.com', verified: false })).status).toBe(403);
    const r = await c.loginWithCode(env.google, { sub: 'friend-sub', email: 'friend@example.com' });
    expect(r.status).toBe(200);
    expect(r.json.user.role).toBe('member');
    expect((await c.request('GET', '/v1/allowlist')).status).toBe(403);
  });
  it('ID tokens with a wrong audience, issuer or expiry are rejected (Android path)', async () => {
    const c = await pairedClient(env);
    const bad = [
      await env.google.idToken({ sub: 'owner-sub', email: 'owner@example.com', aud: 'other-client' }),
      await env.google.idToken({ sub: 'owner-sub', email: 'owner@example.com', iss: 'https://evil.example' }),
      await env.google.idToken({ sub: 'owner-sub', email: 'owner@example.com', expSec: -120 }),
    ];
    for (const idToken of bad) expect((await c.request('POST', '/v1/auth/google/idtoken', { idToken })).status).toBe(401);
    const ok = await c.request('POST', '/v1/auth/google/idtoken', { idToken: await env.google.idToken({ sub: 'owner-sub', email: 'owner@example.com' }) });
    expect(ok.status).toBe(200);
    expect(ok.json.user.role).toBe('owner');
  });
  it('a state cannot be reused and the PKCE verifier must match', async () => {
    const r = await owner.request('POST', '/v1/auth/google/start', { codeChallenge: toB64url(randomBytes(32)), redirectUri: 'http://localhost:47823/oauth/callback' });
    const code = await env.google.issueCode({ sub: 'owner-sub', email: 'owner@example.com' });
    const f = await owner.request('POST', '/v1/auth/google/finish', { code, state: r.json.state, codeVerifier: toB64url(randomBytes(32)) });
    expect(f.json.error).toBe('pkce_mismatch');
    const f2 = await owner.request('POST', '/v1/auth/google/finish', { code, state: r.json.state, codeVerifier: toB64url(randomBytes(32)) });
    expect(f2.json.error).toBe('invalid_state');
  });
});

describe('NFR-SEC-02/03 signatures, sessions and revocation', () => {
  let owner: TestClient;
  beforeAll(async () => {
    owner = new TestClient(env.server.url, env.server.ctx.tls.pin);
    const c = await pairedClient(env);
    const r = await c.request('POST', '/v1/auth/google/idtoken', { idToken: await env.google.idToken({ sub: 'owner-sub', email: 'owner@example.com' }) });
    c.token = r.json.token;
    owner = c;
  });
  it('a missing signature is refused', async () => {
    expect((await owner.request('GET', '/v1/me', undefined, { sign: false })).status).toBe(401);
  });
  it('a replayed nonce and a stale timestamp are refused', async () => {
    const nonce = toB64url(randomBytes(16));
    expect((await owner.request('GET', '/v1/me', undefined, { nonce })).status).toBe(200);
    expect((await owner.request('GET', '/v1/me', undefined, { nonce })).json.error).toBe('replayed_nonce');
    expect((await owner.request('GET', '/v1/me', undefined, { tsOffset: -120_000 })).json.error).toBe('stale_request');
  });
  it('a token from another device is refused', async () => {
    const other = await pairedClient(env);
    expect((await other.request('GET', '/v1/me', undefined, { token: owner.token })).json.error).toBe('session_device_mismatch');
  });
  it('an expired session token is refused, and refresh works through the device signature', async () => {
    env.server.ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE device_id = ?').run(Date.now() - 1, owner.deviceId);
    const r = await owner.request('GET', '/v1/me');
    expect(r.status).toBe(401);
    expect(r.json.error).toBe('session_expired');
    const rf = await owner.request('POST', '/v1/auth/refresh', {}, { token: '' });
    expect(rf.status).toBe(200);
    owner.token = rf.json.token;
    expect((await owner.request('GET', '/v1/me')).status).toBe(200);
  });
  it('a revoked device is refused immediately, including its open WebSocket', async () => {
    const c = await pairedClient(env, { approveAs: owner });
    const r = await c.request('POST', '/v1/auth/google/idtoken', { idToken: await env.google.idToken({ sub: 'owner-sub', email: 'owner@example.com' }) });
    c.token = r.json.token;
    const s = await c.ws();
    s.auth();
    expect((await s.next((f) => f.type === 'ready')).type).toBe('ready');
    const list = await owner.request('GET', '/v1/devices');
    expect(list.json.devices.some((d: { id: string }) => d.id === c.deviceId)).toBe(true);
    expect((await owner.request('DELETE', `/v1/devices/${c.deviceId}`)).status).toBe(200);
    const closed = await s.next((f) => f.type === '__closed');
    expect(closed.code).toBe(4003);
    const after = await c.request('GET', '/v1/me');
    expect(after.status).toBe(403);
    expect(after.json.error).toBe('device_revoked');
  });
  it('owner-approved pairing via a device works end to end', async () => {
    const c = await pairedClient(env, { approveAs: owner });
    expect(c.deviceId).toMatch(/^dev_/);
  });
});

describe('P1 exit: empty chat round-trip over the signed WebSocket', () => {
  it('authenticates, round-trips chat.ping, rejects unsigned frames', async () => {
    const c = await pairedClient(env);
    const r = await c.request('POST', '/v1/auth/google/idtoken', { idToken: await env.google.idToken({ sub: 'owner-sub', email: 'owner@example.com' }) });
    c.token = r.json.token;
    const s = await c.ws();
    s.auth();
    await s.next((f) => f.type === 'ready');
    s.send('chat.ping', { text: 'hello' }, 'm1');
    const ack = await s.next((f) => f.type === 'ack' && f.id === 'm1');
    expect(ack.ok).toBe(true);
    expect(ack.data.echo).toBe('hello');
    s.send('chat.ping', { text: 'x' }, 'm2', { badSig: true });
    expect((await s.next((f) => f.type === 'error')).error).toBe('bad_signature');
    s.close();
  });
  it('closes an unauthenticated socket', async () => {
    const c = await pairedClient(env);
    const s = await c.ws();
    s.send('chat.ping', {}, 'x');
    const f = await s.next((x) => x.type === '__closed');
    expect(f.code).toBe(4001);
  });
});

describe('NFR-SEC-04 at rest', () => {
  it('a raw data-folder dump reveals no secrets', async () => {
    env.server.ctx.db.pragma('wal_checkpoint(TRUNCATE)');
    const needles = ['test-client-secret-1234', 'BEGIN PRIVATE KEY', env.server.ctx.tls.keyPem.split('\n')[1]!.slice(0, 40)];
    const files: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
    walk(env.dataDir);
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const raw = fs.readFileSync(f).toString('latin1');
      for (const n of needles) expect(raw.includes(n), `${n} found in ${f}`).toBe(false);
    }
    // the master key file holds only a wrapped key
    const mf = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'master.json'), 'utf8'));
    expect(mf.method).toBe('passphrase');
    expect(fs.existsSync(path.join(env.unlockDir, 'passphrase'))).toBe(true);
    expect(path.relative(env.dataDir, env.unlockDir).startsWith('..')).toBe(true);
  });
});

describe('NFR-SEC-09 logs', () => {
  it('seeded secrets never appear in logs', async () => {
    env.server.ctx.log.info({ apiKey: 'sk-ant-api03-SEEDEDSECRETVALUE123456', clientSecret: 'test-client-secret-1234' }, 'leak attempt Bearer abcdefghijklmnopqrstuvwxyz');
    const all = env.logs.join('');
    expect(all).not.toContain('SEEDEDSECRETVALUE');
    expect(all).not.toContain('test-client-secret-1234');
    expect(all).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(all).toContain('[REDACTED]');
  });
});

describe('server restart keeps identity', () => {
  it('reopens with the same TLS pin and decrypts secrets', async () => {
    const env2 = await startTestServer();
    const pin = env2.server.ctx.tls.pin;
    env2.server.ctx.secrets.set('x', 'value-123456');
    await env2.close();
    const env3 = await startTestServer({ dataDir: env2.dataDir, unlockDir: env2.unlockDir, google: env2.google });
    expect(env3.server.ctx.tls.pin).toBe(pin);
    expect(env3.server.ctx.secrets.get('x')).toBe('value-123456');
    await env3.close();
  });
  it('refuses to start without the unlock passphrase', async () => {
    const env2 = await startTestServer();
    await env2.close();
    fs.rmSync(path.join(env2.unlockDir, 'passphrase'));
    await expect(startTestServer({ dataDir: env2.dataDir, unlockDir: env2.unlockDir })).rejects.toThrow(/locked/);
  });
});
