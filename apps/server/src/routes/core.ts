// Pairing, setup wizard, Google login, sessions, devices and allowlist routes (P1).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  PairStartReq, PairApproveReq, SetupGoogleReq, GoogleStartReq, GoogleFinishReq, GoogleIdTokenReq, AddAllowlistReq,
  DESKTOP_OAUTH_REDIRECT, type ServerInfo,
} from '@advence/protocol';
import { authenticate, parse, sendError, HttpError, type AuthLevel } from '../http.js';
import type { AppContext } from '../context.js';
import { getMeta, setMeta } from '../db.js';
import { newToken } from '../ids.js';
import { LOGIN_SCOPES } from '../auth/google.js';
import { RateLimiter } from '../ratelimit.js';
import { ANDROID_PACKAGE, ANDROID_SIGNING_SHA1 } from '../build-info.js';

const OAUTH_STATE_TTL = 10 * 60_000;

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  const publicLimiter = new RateLimiter(20, 60_000);

  type Handler = (req: FastifyRequest) => Promise<unknown> | unknown;
  const route = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT', url: string, level: AuthLevel | 'public' | 'setup', h: Handler) => {
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        try {
          if (level === 'public') {
            if (!publicLimiter.take(req.ip)) throw new HttpError(429, 'rate_limited');
          } else if (level === 'setup') {
            // Setup is open to any paired device until an owner exists, then owner only.
            req.auth = authenticate(ctx, req, ctx.identity.hasOwner() ? 'owner' : 'device');
          } else {
            req.auth = authenticate(ctx, req, level);
          }
          const out = await h(req);
          return reply.send(out ?? { ok: true });
        } catch (e) {
          return sendError(reply, e);
        }
      },
    });
  };

  route('GET', '/v1/health', 'public', () => ({ ok: true, version: ctx.config.version }));

  route('GET', '/v1/server-info', 'public', (): ServerInfo => ({
    name: ctx.serverName(),
    version: ctx.config.version,
    setupRequired: !ctx.google(),
    hasOwner: ctx.identity.hasOwner(),
    googleConfigured: !!ctx.google(),
    browserUi: getMeta(ctx.db, 'settings.browserUi') === 'true',
  }));

  // ---- pairing (FR-CLI-03)
  route('POST', '/v1/pair/start', 'public', (req) => {
    const b = parse(PairStartReq, req.body);
    const r = ctx.identity.startPairing(b);
    ctx.bus.publish('*', 'pairing.pending', { pairingId: r.pairingId });
    return r;
  });

  route('GET', '/v1/pair/status/:id', 'device-pending', (req) => {
    const id = (req.params as { id: string }).id;
    return { status: ctx.identity.pairingStatus(id, req.auth!.deviceId) };
  });

  route('GET', '/v1/pairings', 'owner', () => ({ pairings: ctx.identity.pendingPairings() }));

  route('POST', '/v1/pairings/:id/approve', 'owner', (req) => {
    const { code } = parse(PairApproveReq, req.body);
    ctx.identity.approvePairing((req.params as { id: string }).id, code);
    return { ok: true };
  });

  route('POST', '/v1/pairings/:id/reject', 'owner', (req) => {
    ctx.identity.rejectPairing((req.params as { id: string }).id);
    return { ok: true };
  });

  route('POST', '/v1/pairing-tokens', 'owner', (req) => {
    const host = hostOf(req, ctx.config.port);
    const t = ctx.identity.createPairingToken(req.auth!.user!.id, host, ctx.serverName());
    return { link: t.link, expiresAt: t.expiresAt };
  });

  // ---- setup wizard (FR-GGL-01)
  route('GET', '/v1/setup', 'setup', () => ({
    webRedirectUri: DESKTOP_OAUTH_REDIRECT,
    androidPackage: ANDROID_PACKAGE,
    androidSha1: ANDROID_SIGNING_SHA1,
    scopes: [...LOGIN_SCOPES],
    steps: [
      { id: 'project', url: 'https://console.cloud.google.com/projectcreate' },
      { id: 'apis', url: 'https://console.cloud.google.com/apis/library' },
      { id: 'consent', url: 'https://console.cloud.google.com/auth/branding' },
      { id: 'audience', url: 'https://console.cloud.google.com/auth/audience' },
      { id: 'webClient', url: 'https://console.cloud.google.com/auth/clients/create' },
      { id: 'androidClient', url: 'https://console.cloud.google.com/auth/clients/create' },
      { id: 'paste' },
    ],
  }));

  route('POST', '/v1/setup/google', 'setup', (req) => {
    const b = parse(SetupGoogleReq, req.body);
    setMeta(ctx.db, 'google.clientId', b.clientId);
    ctx.secrets.set('google.clientSecret', b.clientSecret);
    return { ok: true };
  });

  // ---- Google login (FR-GGL-02/03, DL-006)
  route('POST', '/v1/auth/google/start', 'device', (req) => {
    const g = ctx.google();
    if (!g) throw new HttpError(409, 'google_not_configured');
    const b = parse(GoogleStartReq, req.body);
    if (b.redirectUri !== DESKTOP_OAUTH_REDIRECT) throw new HttpError(400, 'invalid_redirect_uri');
    const state = newToken(24);
    ctx.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(Date.now());
    ctx.db
      .prepare('INSERT INTO oauth_states(state, device_id, code_challenge, redirect_uri, purpose, expires_at) VALUES(?,?,?,?,?,?)')
      .run(state, req.auth!.deviceId, b.codeChallenge, b.redirectUri, 'login', Date.now() + OAUTH_STATE_TTL);
    return { url: g.authorizationUrl({ redirectUri: b.redirectUri, state, codeChallenge: b.codeChallenge, scopes: LOGIN_SCOPES }), state };
  });

  route('POST', '/v1/auth/google/finish', 'device', async (req) => {
    const g = ctx.google();
    if (!g) throw new HttpError(409, 'google_not_configured');
    const b = parse(GoogleFinishReq, req.body);
    const st = ctx.db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(b.state) as
      | { device_id: string; code_challenge: string; redirect_uri: string; purpose: string; expires_at: number }
      | undefined;
    ctx.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(b.state);
    if (!st || st.device_id !== req.auth!.deviceId || st.expires_at < Date.now() || st.purpose !== 'login') throw new HttpError(400, 'invalid_state');
    if (pkceChallenge(b.codeVerifier) !== st.code_challenge) throw new HttpError(400, 'pkce_mismatch');
    const tokens = await g.exchangeCode(b.code, b.codeVerifier, st.redirect_uri);
    return login(ctx, req.auth!.deviceId, await g.verifyIdToken(tokens.idToken));
  });

  route('GET', '/v1/auth/google/client', 'device', () => {
    const id = getMeta(ctx.db, 'google.clientId');
    if (!id) throw new HttpError(409, 'google_not_configured');
    return { clientId: id };
  });

  route('POST', '/v1/auth/google/idtoken', 'device', async (req) => {
    const g = ctx.google();
    if (!g) throw new HttpError(409, 'google_not_configured');
    const { idToken } = parse(GoogleIdTokenReq, req.body);
    return login(ctx, req.auth!.deviceId, await g.verifyIdToken(idToken));
  });

  route('POST', '/v1/auth/refresh', 'device', (req) => ctx.identity.refreshSession(req.auth!.deviceId));

  route('POST', '/v1/auth/logout', 'session', (req) => {
    ctx.identity.endSession(req.auth!.token!);
    return { ok: true };
  });

  route('GET', '/v1/me', 'session', (req) => ({ user: req.auth!.user, deviceId: req.auth!.deviceId }));

  // ---- devices (NFR-SEC-02)
  route('GET', '/v1/devices', 'session', (req) => {
    const u = req.auth!.user!;
    return { devices: ctx.identity.listDevices(u.id, req.auth!.deviceId, u.role === 'owner') };
  });

  route('DELETE', '/v1/devices/:id', 'session', (req) => {
    const id = (req.params as { id: string }).id;
    const d = ctx.identity.getDevice(id);
    const u = req.auth!.user!;
    if (!d) throw new HttpError(404, 'not_found');
    if (u.role !== 'owner' && d.user_id !== u.id) throw new HttpError(403, 'forbidden');
    ctx.identity.revokeDevice(id);
    return { ok: true };
  });

  // ---- allowlist (FR-GGL-03)
  route('GET', '/v1/allowlist', 'owner', () => ({ entries: ctx.identity.listAllowlist() }));
  route('POST', '/v1/allowlist', 'owner', (req) => {
    const { email } = parse(AddAllowlistReq, req.body);
    return { id: ctx.identity.addAllowlist(email) };
  });
  route('DELETE', '/v1/allowlist/:id', 'owner', (req) => {
    ctx.identity.removeAllowlist((req.params as { id: string }).id);
    return { ok: true };
  });
}

function login(ctx: AppContext, deviceId: string, g: Parameters<AppContext['identity']['resolveLogin']>[0]) {
  const user = ctx.identity.resolveLogin(g);
  ctx.identity.bindDevice(deviceId, user.id);
  const s = ctx.identity.issueSession(deviceId, user.id);
  ctx.log.info({ userId: user.id, deviceId }, 'login');
  return { token: s.token, expiresAt: s.expiresAt, user };
}

import { createHash } from 'node:crypto';
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function hostOf(req: FastifyRequest, port: number): string {
  const h = String(req.headers.host ?? '');
  if (/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):\d{1,5}$/.test(h)) return h;
  if (/^[A-Za-z0-9.-]+$/.test(h)) return `${h}:${port}`;
  return `localhost:${port}`;
}
