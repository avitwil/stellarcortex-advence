// Test harness: temp data dir, mock Google OIDC (real RS256 tokens), pinned TLS client.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from 'jose';
import WebSocket from 'ws';
import {
  generateDeviceKey, signRequest, toB64url, randomBytes, spkiPin, sign, canonicalFrame, newNonce, utf8, type DeviceKeyPair,
  decodePairingLink, type SessionRes,
} from '@advence/protocol';
import { startServer, type Server, type BootOptions } from '../app.js';
import { NoRuntime } from '../computer/index.js';
import type { GoogleEndpoints } from '../auth/google.js';
import { createLogger } from '../log.js';

/** https.Agent that verifies the pinned SPKI before handing the socket to any request. */
export class PinnedAgent extends https.Agent {
  constructor(private pin: string) {
    super({ keepAlive: false, maxCachedSessions: 0 });
  }
  override createConnection(options: https.RequestOptions, cb?: (err: Error | null, s: import('node:stream').Duplex) => void): undefined {
    const s = tls.connect({ ...(options as tls.ConnectionOptions), rejectUnauthorized: false, minVersion: 'TLSv1.3' });
    s.once('secureConnect', () => {
      const cert = s.getPeerX509Certificate();
      const got = cert ? spkiPin(new Uint8Array(cert.publicKey.export({ type: 'spki', format: 'der' }))) : '';
      if (got !== this.pin) {
        s.destroy();
        cb?.(new Error('pin_mismatch'), s);
        return;
      }
      cb?.(null, s);
    });
    s.once('error', (e) => cb?.(e, s));
    return undefined;
  }
}

export const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';

export interface MockGoogle {
  endpoints: GoogleEndpoints;
  fetchImpl: typeof fetch;
  /** registers an authorization code that will return a token for this identity */
  issueCode(id: { sub: string; email: string; name?: string; verified?: boolean }): Promise<string>;
  idToken(id: { sub: string; email: string; name?: string; verified?: boolean; aud?: string; iss?: string; expSec?: number }): Promise<string>;
  lastTokenRequest?: URLSearchParams;
  /** scopes the consent screen grants (FR-GGL-04 tests); default: none reported */
  grantedScope?: string;
  /** makes refresh fail with this OAuth error (for example invalid_grant) */
  refreshError?: string;
  refreshes: number;
  revoked: string[];
}

export async function mockGoogle(): Promise<MockGoogle> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = (await exportJWK(publicKey)) as JWK;
  jwk.kid = 'k1';
  jwk.alg = 'RS256';
  const codes = new Map<string, string>();
  // Like Google: revoking any token of a grant ends the whole grant (every refresh token of it).
  const grantOf = new Map<string, string>();
  const deadGrants = new Set<string>();
  const subOf = (idToken: string) => (JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString()) as { sub: string }).sub;
  const m: MockGoogle = {
    refreshes: 0,
    revoked: [],
    endpoints: {
      authorization: 'https://accounts.example.test/o/oauth2/v2/auth',
      token: 'https://oauth2.example.test/token',
      revocation: 'https://oauth2.example.test/revoke',
      jwks: createLocalJWKSet({ keys: [jwk] }),
      issuers: ['https://accounts.google.com', 'accounts.google.com'],
    },
    async idToken(id) {
      return new SignJWT({ email: id.email, email_verified: id.verified ?? true, name: id.name ?? id.email.split('@')[0] })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setSubject(id.sub)
        .setIssuer(id.iss ?? 'https://accounts.google.com')
        .setAudience(id.aud ?? CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + (id.expSec ?? 3600))
        .sign(privateKey);
    },
    async issueCode(id) {
      const code = toB64url(randomBytes(12));
      codes.set(code, await m.idToken(id));
      return code;
    },
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      if (String(url) === m.endpoints.revocation) {
        m.revoked.push(body.get('token') ?? '');
        const g = grantOf.get(body.get('token') ?? '');
        if (g) deadGrants.add(g);
        return new Response(null, { status: 200 });
      }
      m.lastTokenRequest = body;
      if (String(url) !== m.endpoints.token) return new Response('not found', { status: 404 });
      if (body.get('grant_type') === 'authorization_code') {
        const t = codes.get(body.get('code') ?? '');
        codes.delete(body.get('code') ?? '');
        if (!t || body.get('client_secret') !== 'test-client-secret-1234') return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const refresh = `1//test-refresh-token-${toB64url(randomBytes(9))}`;
        const grant = `${subOf(t)}:${toB64url(randomBytes(6))}`;
        // A new consent after the grant ended starts a new grant; otherwise it joins the live one.
        const live = [...grantOf.values()].find((x) => x.startsWith(`${subOf(t)}:`) && !deadGrants.has(x));
        grantOf.set(refresh, live ?? grant);
        return Response.json({ id_token: t, access_token: 'ya29.test-access-token', refresh_token: refresh, expires_in: 3600, scope: m.grantedScope ?? body.get('scope') ?? '' });
      }
      if (body.get('grant_type') === 'refresh_token') {
        m.refreshes++;
        if (m.refreshError) return Response.json({ error: m.refreshError }, { status: 400 });
        const g = grantOf.get(body.get('refresh_token') ?? '');
        if (g && deadGrants.has(g)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        return Response.json({ access_token: 'ya29.refreshed-access-token', expires_in: 3600 });
      }
      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }) as typeof fetch,
  };
  return m;
}

export interface TestEnv {
  server: Server;
  dataDir: string;
  unlockDir: string;
  google: MockGoogle;
  logs: string[];
  close(): Promise<void>;
}

export async function startTestServer(opts: { dataDir?: string; unlockDir?: string; google?: MockGoogle; boot?: Partial<BootOptions>; host?: string } = {}): Promise<TestEnv> {
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'advence-data-'));
  const unlockDir = opts.unlockDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'advence-unlock-'));
  const google = opts.google ?? (await mockGoogle());
  const logs: string[] = [];
  const server = await startServer({
    config: { dataDir, unlockDir, host: opts.host ?? '127.0.0.1', port: 0, version: 'test' },
    keystore: null,
    googleEndpoints: google.endpoints,
    fetchImpl: google.fetchImpl,
    logger: createLogger('debug', (l) => void logs.push(l)),
    // No real containers in tests unless a test brings its own runtime.
    containerRuntime: new NoRuntime(),
    ...opts.boot,
  });
  return { server, dataDir, unlockDir, google, logs, close: () => server.close() };
}

/** A device client that pins the server key, exactly like the real clients do (NFR-SEC-01). */
export class TestClient {
  key: DeviceKeyPair = generateDeviceKey();
  deviceId = '';
  token = '';
  constructor(public url: string, public pin: string) {}

  static fromLink(link: string, port: number): TestClient {
    const l = decodePairingLink(link);
    return new TestClient(`https://127.0.0.1:${port}`, l.pin);
  }

  agent(): https.Agent {
    return new PinnedAgent(this.pin);
  }

  async request(method: string, p: string, body?: unknown, opts: { sign?: boolean; token?: string; headers?: Record<string, string>; tsOffset?: number; nonce?: string } = {}): Promise<{ status: number; json: any }> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...(raw ? { 'content-type': 'application/json' } : {}) };
    const token = opts.token ?? this.token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.sign !== false && this.deviceId) {
      Object.assign(headers, signRequest(this.key.secretKey, { method, path: p, body: utf8(raw), deviceId: this.deviceId, token: token ?? '', ts: Date.now() + (opts.tsOffset ?? 0), nonce: opts.nonce }));
    }
    Object.assign(headers, opts.headers ?? {});
    const u = new URL(this.url + p);
    return new Promise((resolve, reject) => {
      const req = https.request({ method, hostname: u.hostname, port: u.port, path: p, headers, agent: this.agent() }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }));
      });
      req.on('error', reject);
      if (raw) req.write(raw);
      req.end();
    });
  }

  async pair(link: string, name = 'Test device', platform = 'linux'): Promise<{ pairingId: string; code: string }> {
    const l = decodePairingLink(link);
    const r = await this.request('POST', '/v1/pair/start', { token: l.token, publicKey: toB64url(this.key.publicKey), name, platform }, { sign: false });
    if (r.status !== 200) throw new Error(`pair failed ${r.status} ${JSON.stringify(r.json)}`);
    this.deviceId = r.json.deviceId;
    return { pairingId: r.json.pairingId, code: r.json.code };
  }

  async loginWithCode(google: MockGoogle, id: { sub: string; email: string; verified?: boolean }): Promise<{ status: number; json: SessionRes & { error?: string } }> {
    const verifier = toB64url(randomBytes(32));
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const s = await this.request('POST', '/v1/auth/google/start', { codeChallenge: challenge, redirectUri: 'http://localhost:47823/oauth/callback' });
    if (s.status !== 200) return s;
    const code = await google.issueCode(id);
    const r = await this.request('POST', '/v1/auth/google/finish', { code, state: s.json.state, codeVerifier: verifier });
    if (r.status === 200) this.token = r.json.token;
    return r;
  }

  ws(): Promise<TestSocket> {
    return TestSocket.open(this);
  }
}

export class TestSocket {
  frames: any[] = [];
  private waiters: ((f: any) => void)[] = [];
  closed: { code: number; reason: string } | null = null;
  private constructor(public ws: WebSocket, private c: TestClient) {
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      this.frames.push(f);
      this.waiters.splice(0).forEach((w) => w(f));
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.waiters.splice(0).forEach((w) => w({ type: '__closed', code }));
    });
  }

  static open(c: TestClient): Promise<TestSocket> {
    const wsUrl = c.url.replace('https://', 'wss://') + '/v1/ws';
    const ws = new WebSocket(wsUrl, { agent: c.agent() });
    const s = new TestSocket(ws, c);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(s));
      ws.once('error', reject);
    });
  }

  auth(token = this.c.token): void {
    const ts = Date.now();
    const nonce = newNonce();
    const sig = toB64url(sign(this.c.key.secretKey, canonicalFrame({ deviceId: this.c.deviceId, ts, nonce, type: 'auth', payload: token })));
    this.ws.send(JSON.stringify({ type: 'auth', deviceId: this.c.deviceId, token, ts, nonce, sig }));
  }

  send(type: string, payload: unknown, id?: string, opts: { badSig?: boolean } = {}): void {
    const ts = Date.now();
    const nonce = newNonce();
    const p = JSON.stringify(payload);
    let sig = toB64url(sign(this.c.key.secretKey, canonicalFrame({ deviceId: this.c.deviceId, ts, nonce, type, payload: p })));
    if (opts.badSig) sig = toB64url(randomBytes(64));
    this.ws.send(JSON.stringify({ type, id, payload: p, ts, nonce, sig }));
  }

  async next(pred: (f: any) => boolean = () => true, timeoutMs = 5000): Promise<any> {
    const found = this.frames.find(pred);
    if (found) {
      this.frames.splice(this.frames.indexOf(found), 1);
      return found;
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for frame')), timeoutMs);
      const check = (f: any) => {
        if (f.type === '__closed' || pred(f)) {
          clearTimeout(t);
          if (f.type !== '__closed') this.frames.splice(this.frames.indexOf(f), 1);
          resolve(f);
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** Creates a pairing token on the server (like `advence pair`), pairs and approves a client. */
export async function pairedClient(env: TestEnv, opts: { approveAs?: TestClient } = {}): Promise<TestClient> {
  const port = Number(new URL(env.server.url).port);
  let link: string;
  if (opts.approveAs) {
    const r = await opts.approveAs.request('POST', '/v1/pairing-tokens', {});
    link = r.json.link;
  } else {
    link = env.server.ctx.identity.createPairingToken(null, `127.0.0.1:${port}`, 'Test server').link;
  }
  const c = TestClient.fromLink(link, port);
  const { pairingId, code } = await c.pair(link);
  if (opts.approveAs) {
    const r = await opts.approveAs.request('POST', `/v1/pairings/${pairingId}/approve`, { code });
    if (r.status !== 200) throw new Error('approve failed ' + JSON.stringify(r.json));
  } else env.server.ctx.identity.approvePairing(pairingId, code);
  return c;
}

export async function configureGoogle(c: TestClient): Promise<void> {
  const r = await c.request('POST', '/v1/setup/google', { clientId: CLIENT_ID, clientSecret: 'test-client-secret-1234' });
  if (r.status !== 200) throw new Error('setup failed ' + JSON.stringify(r.json));
}

export async function ownerClient(env: TestEnv): Promise<TestClient> {
  const c = await pairedClient(env);
  await configureGoogle(c);
  const r = await c.loginWithCode(env.google, { sub: 'owner-sub', email: 'owner@example.com' });
  if (r.status !== 200) throw new Error('owner login failed ' + JSON.stringify(r.json));
  return c;
}

export function pinOfPem(pem: string): string {
  return spkiPin(new Uint8Array(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })));
}
