// Signed API client (NFR-SEC-02/03): every request carries a device signature; the
// short-lived session token is refreshed through the device signature.
import {
  signRequest, generateDeviceKey, pairingCode, publicKeyFromSecret, toB64url, fromB64url, utf8, sha256, randomBytes,
  DESKTOP_OAUTH_REDIRECT, type SessionRes, type User, type ServerInfo, type Platform,
} from '@advence/protocol';
import type { PlatformBridge } from '../platform/types';
import type { SavedServer } from './servers';
import { ReconnectingSocket } from './socket';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export class ApiClient {
  private secret: Uint8Array | null = null;
  token = '';
  expiresAt = 0;
  user: User | null = null;
  private refreshing: Promise<void> | null = null;
  socket: ReconnectingSocket | null = null;

  constructor(readonly server: SavedServer, private bridge: PlatformBridge) {}

  get base(): string {
    return `https://${this.server.host}`;
  }

  private keyName(): string {
    return `device-key:${this.server.id}`;
  }

  async ensureKey(): Promise<Uint8Array> {
    if (this.secret) return this.secret;
    const saved = await this.bridge.loadSecret(this.keyName());
    if (saved) this.secret = fromB64url(saved);
    else {
      const kp = generateDeviceKey();
      await this.bridge.saveSecret(this.keyName(), toB64url(kp.secretKey));
      this.secret = kp.secretKey;
    }
    return this.secret;
  }

  async publicKey(): Promise<string> {
    return toB64url(publicKeyFromSecret(await this.ensureKey()));
  }

  async forgetKey(): Promise<void> {
    await this.bridge.deleteSecret(this.keyName());
    this.secret = null;
  }

  async raw<T>(method: string, path: string, body?: unknown, opts: { sign?: boolean; session?: boolean } = {}): Promise<T> {
    await this.bridge.trustServer(this.server.host, this.server.pin);
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (raw) headers['content-type'] = 'application/json';
    const token = opts.session === false ? '' : this.token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.sign !== false && this.server.deviceId) {
      Object.assign(headers, signRequest(await this.ensureKey(), { method, path, body: utf8(raw), deviceId: this.server.deviceId, token }));
    }
    const res = await this.bridge.http({ url: this.base + path, method, headers, body: raw || undefined });
    let json: any = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      json = null;
    }
    if (res.status >= 400) throw new ApiError(res.status, json?.error ?? `http_${res.status}`);
    return json as T;
  }

  /** Session request with automatic refresh through the device signature. */
  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureSession();
    try {
      return await this.raw<T>(method, path, body);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'session_expired' || e.code === 'invalid_session')) {
        await this.refresh();
        return this.raw<T>(method, path, body);
      }
      throw e;
    }
  }

  async ensureSession(): Promise<void> {
    if (this.token && this.expiresAt - Date.now() > 60_000) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const s = await this.raw<SessionRes>('POST', '/v1/auth/refresh', {}, { session: false });
        this.setSession(s);
      })().finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  setSession(s: SessionRes): void {
    this.token = s.token;
    this.expiresAt = s.expiresAt;
    this.user = s.user;
    this.socket?.reauth();
  }

  serverInfo(): Promise<ServerInfo> {
    return this.raw<ServerInfo>('GET', '/v1/server-info', undefined, { sign: false, session: false });
  }

  /**
   * The 6-digit code shown to the user is computed here from the pin in the pairing link and
   * our own key, never taken from the server, so a man in the middle shows a different code
   * than the server does (FR-CLI-03).
   */
  async startPairing(token: string, name: string, platform: Platform): Promise<{ pairingId: string; deviceId: string; code: string }> {
    const publicKey = await this.publicKey();
    const r = await this.raw<{ pairingId: string; deviceId: string; code: string }>('POST', '/v1/pair/start', { token, publicKey, name, platform }, { sign: false, session: false });
    return { pairingId: r.pairingId, deviceId: r.deviceId, code: pairingCode(this.server.pin, fromB64url(publicKey), r.pairingId) };
  }

  pairingStatus(pairingId: string): Promise<{ status: 'pending' | 'approved' | 'rejected' | 'expired' }> {
    return this.raw('GET', `/v1/pair/status/${encodeURIComponent(pairingId)}`, undefined, { session: false });
  }

  /** Desktop/browser Google login (DL-006/DL-007). Returns the auth URL and PKCE verifier. */
  async googleStart(): Promise<{ url: string; state: string; verifier: string }> {
    const verifier = toB64url(randomBytes(32));
    const challenge = toB64url(sha256(verifier));
    const r = await this.raw<{ url: string; state: string }>('POST', '/v1/auth/google/start', { codeChallenge: challenge, redirectUri: DESKTOP_OAUTH_REDIRECT }, { session: false });
    return { ...r, verifier };
  }

  async googleFinish(code: string, state: string, verifier: string): Promise<SessionRes> {
    const s = await this.raw<SessionRes>('POST', '/v1/auth/google/finish', { code, state, codeVerifier: verifier }, { session: false });
    this.setSession(s);
    return s;
  }

  async googleIdToken(idToken: string): Promise<SessionRes> {
    const s = await this.raw<SessionRes>('POST', '/v1/auth/google/idtoken', { idToken }, { session: false });
    this.setSession(s);
    return s;
  }

  openSocket(): ReconnectingSocket {
    if (!this.socket) this.socket = new ReconnectingSocket(this, this.bridge);
    return this.socket;
  }

  async secretKey(): Promise<Uint8Array> {
    return this.ensureKey();
  }

  close(): void {
    this.socket?.stop();
    this.socket = null;
  }
}
