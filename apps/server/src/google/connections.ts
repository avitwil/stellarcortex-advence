// Google services for each user (FR-GGL-04, FR-GGL-05): one consent screen for Gmail, Calendar,
// Drive and Contacts, right after login. The refresh token is sealed. The operator's Google
// project runs in Testing mode (DL-059), where Google drops such refresh tokens after 7 days:
// the server tracks the age, reminds on day 6 with a one-tap reconnect, and shows "reconnect"
// once the token is gone, instead of failing in the middle of a Bot's work.
import { DESKTOP_OAUTH_REDIRECT, type GoogleConnectFinish, type GoogleConnection, type GoogleService, type User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';
import { newToken } from '../ids.js';
import { pkceChallenge } from '../routes/core.js';
import type { Push } from '../chat/push.js';

export const DAY = 24 * 60 * 60_000;
/** Testing-mode refresh tokens for sensitive scopes stop working 7 days after consent. */
export const TESTING_LIFETIME_MS = 7 * DAY;
export const REMIND_AFTER_MS = 6 * DAY;
const STATE_TTL_MS = 10 * 60_000;

/** Least privilege for what the Bots do (FR-GGL-06); see DL-059. */
export const SERVICE_SCOPES: Record<GoogleService, string[]> = {
  gmail: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'],
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  drive: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
  contacts: ['https://www.googleapis.com/auth/contacts.readonly'],
};
export const CONNECT_SCOPES = ['openid', 'email', ...Object.values(SERVICE_SCOPES).flat()];
export const SERVICES = Object.keys(SERVICE_SCOPES) as GoogleService[];

interface Body {
  refreshToken: string;
  accessToken: string | null;
  accessExpiresAt: number;
  scopes: string[];
  email: string;
}

interface Row { user_id: string; body: Buffer; state: string; connected_at: number; expires_at: number | null; reminded_at: number | null }

export class GoogleReconnectNeeded extends Error {
  constructor() {
    super('google_reconnect');
  }
}

export class GoogleConnections {
  /** replaceable in tests to move the clock */
  now: () => number = Date.now;
  private timer: NodeJS.Timeout;
  private refreshing = new Map<string, Promise<string>>();

  constructor(private ctx: AppContext, private push: Push | null) {
    this.timer = setInterval(() => void this.tick(), 60 * 60_000);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  private oidc() {
    const g = this.ctx.google();
    if (!g) throw new HttpError(409, 'google_not_configured');
    return g;
  }

  private row(userId: string): Row | undefined {
    return this.ctx.db.prepare('SELECT * FROM google_connections WHERE user_id = ?').get(userId) as Row | undefined;
  }

  private open(r: Row): Body {
    return JSON.parse(this.ctx.crypto.openContent(r.body, `google:${r.user_id}`)) as Body;
  }

  private seal(userId: string, b: Body): Buffer {
    return this.ctx.crypto.sealContent(JSON.stringify(b), `google:${userId}`);
  }

  private stateOf(r: Row): GoogleConnection['state'] {
    const now = this.now();
    if (r.state === 'reconnect' || (r.expires_at !== null && now >= r.expires_at)) return 'reconnect';
    if (now >= r.connected_at + REMIND_AFTER_MS) return 'expiring';
    return 'ok';
  }

  get(user: User): GoogleConnection {
    const r = this.row(user.id);
    if (!r) return { state: 'none', email: null, services: [], connectedAt: null, expiresAt: null, missing: [] };
    const b = this.open(r);
    const services = servicesOf(b.scopes);
    return { state: this.stateOf(r), email: b.email, services, connectedAt: r.connected_at, expiresAt: r.expires_at, missing: SERVICES.filter((s) => !services.includes(s)) };
  }

  /** Services the Bots can use right now (connected, granted and not expired). */
  usable(user: User): GoogleService[] {
    const c = this.get(user);
    return c.state === 'ok' || c.state === 'expiring' ? c.services : [];
  }

  info(): { clientId: string; scopes: string[] } {
    return { clientId: this.oidc().clientIdValue, scopes: CONNECT_SCOPES };
  }

  start(user: User, deviceId: string, p: { redirectUri: string; codeChallenge: string }): { url: string; state: string } {
    const g = this.oidc();
    if (p.redirectUri !== DESKTOP_OAUTH_REDIRECT) throw new HttpError(400, 'invalid_redirect_uri');
    const state = newToken(24);
    this.ctx.db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(Date.now());
    this.ctx.db
      .prepare('INSERT INTO oauth_states(state, device_id, code_challenge, redirect_uri, purpose, expires_at) VALUES(?,?,?,?,?,?)')
      .run(state, deviceId, p.codeChallenge, p.redirectUri, `google:${user.id}`, Date.now() + STATE_TTL_MS);
    // prompt=consent: Google returns a refresh token only on a fresh consent.
    return { url: g.authorizationUrl({ redirectUri: p.redirectUri, state, codeChallenge: p.codeChallenge, scopes: CONNECT_SCOPES, consent: true, loginHint: user.email }), state };
  }

  async finish(user: User, deviceId: string, f: GoogleConnectFinish): Promise<GoogleConnection> {
    const g = this.oidc();
    let tokens;
    if ('serverAuthCode' in f) {
      tokens = await g.exchangeCode(f.serverAuthCode, undefined, '').catch(() => {
        throw new HttpError(400, 'google_exchange_failed');
      });
    } else {
      const st = this.ctx.db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(f.state) as { device_id: string; code_challenge: string; redirect_uri: string; purpose: string; expires_at: number } | undefined;
      this.ctx.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(f.state);
      if (!st || st.device_id !== deviceId || st.purpose !== `google:${user.id}` || st.expires_at < Date.now()) throw new HttpError(400, 'invalid_state');
      if (pkceChallenge(f.codeVerifier) !== st.code_challenge) throw new HttpError(400, 'pkce_mismatch');
      tokens = await g.exchangeCode(f.code, f.codeVerifier, st.redirect_uri).catch(() => {
        throw new HttpError(400, 'google_exchange_failed');
      });
    }
    const id = await g.verifyIdToken(tokens.idToken).catch(() => {
      throw new HttpError(400, 'invalid_id_token');
    });
    if (!tokens.refreshToken) throw new HttpError(400, 'google_no_refresh_token');
    const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
    if (!servicesOf(scopes).length) throw new HttpError(400, 'google_no_services_granted');
    const now = this.now();
    const old = this.row(user.id);
    const body: Body = { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken ?? null, accessExpiresAt: now + (tokens.expiresIn ?? 0) * 1000, scopes, email: id.email };
    this.ctx.db
      .prepare(
        `INSERT INTO google_connections(user_id, body, state, connected_at, expires_at, reminded_at) VALUES(?,?,?,?,?,NULL)
         ON CONFLICT(user_id) DO UPDATE SET body = excluded.body, state = excluded.state, connected_at = excluded.connected_at, expires_at = excluded.expires_at, reminded_at = NULL`,
      )
      .run(user.id, this.seal(user.id, body), 'ok', now, now + TESTING_LIFETIME_MS);
    // A new consent replaces the old grant; the old refresh token is revoked.
    if (old) {
      const prev = this.open(old);
      if (prev.refreshToken !== body.refreshToken) void g.revoke(prev.refreshToken);
    }
    const view = this.get(user);
    this.ctx.bus.publish(user.id, 'google.connection', view);
    return view;
  }

  async disconnect(user: User): Promise<GoogleConnection> {
    const r = this.row(user.id);
    if (r) {
      const b = this.open(r);
      this.ctx.db.prepare('DELETE FROM google_connections WHERE user_id = ?').run(user.id);
      await this.ctx.google()?.revoke(b.refreshToken);
    }
    const view = this.get(user);
    this.ctx.bus.publish(user.id, 'google.connection', view);
    return view;
  }

  /** A valid access token, refreshed when it is about to run out. */
  async accessToken(user: User, force = false): Promise<string> {
    const r = this.row(user.id);
    if (!r || this.stateOf(r) === 'reconnect') throw new GoogleReconnectNeeded();
    const b = this.open(r);
    if (!force && b.accessToken && b.accessExpiresAt - 60_000 > this.now()) return b.accessToken;
    const running = this.refreshing.get(user.id);
    if (running) return running;
    const p = (async () => {
      try {
        const t = await this.oidc().refresh(b.refreshToken);
        const cur = this.row(user.id);
        if (cur) {
          const nb = { ...this.open(cur), accessToken: t.accessToken, accessExpiresAt: this.now() + t.expiresIn * 1000 };
          this.ctx.db.prepare('UPDATE google_connections SET body = ? WHERE user_id = ?').run(this.seal(user.id, nb), user.id);
        }
        return t.accessToken;
      } catch (e) {
        if ((e as Error).message === 'invalid_grant') {
          this.markReconnect(user.id);
          throw new GoogleReconnectNeeded();
        }
        throw e;
      } finally {
        this.refreshing.delete(user.id);
      }
    })();
    this.refreshing.set(user.id, p);
    return p;
  }

  private markReconnect(userId: string): void {
    const r = this.row(userId);
    if (!r || r.state === 'reconnect') return;
    this.ctx.db.prepare("UPDATE google_connections SET state = 'reconnect' WHERE user_id = ?").run(userId);
    const user = this.ctx.identity.getUser(userId);
    if (user) this.ctx.bus.publish(userId, 'google.connection', this.get(user));
  }

  /** Day-6 reminder (once per consent) and the switch to "reconnect" when the token runs out. */
  async tick(): Promise<void> {
    const now = this.now();
    const rows = this.ctx.db.prepare('SELECT * FROM google_connections').all() as Row[];
    for (const r of rows) {
      const user = this.ctx.identity.getUser(r.user_id);
      if (!user) continue;
      if (r.state !== 'reconnect' && r.expires_at !== null && now >= r.expires_at) {
        this.markReconnect(r.user_id);
        continue;
      }
      if (r.reminded_at === null && now >= r.connected_at + REMIND_AFTER_MS && this.stateOf(r) === 'expiring') {
        this.ctx.db.prepare('UPDATE google_connections SET reminded_at = ? WHERE user_id = ?').run(now, r.user_id);
        this.ctx.bus.publish(r.user_id, 'google.connection', { ...this.get(user), reminder: true });
        // Android: a wake-up only; the app fetches the state and shows the one-tap reconnect.
        await this.push?.wake(r.user_id, 'google-reconnect').catch(() => 0);
      }
    }
  }
}

export function servicesOf(scopes: string[]): GoogleService[] {
  const have = new Set(scopes);
  return SERVICES.filter((s) => SERVICE_SCOPES[s].every((x) => have.has(x)));
}
