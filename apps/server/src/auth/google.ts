// Google OIDC relying party (D-13, FR-GGL-02). The server holds the Web client secret,
// exchanges authorization codes and verifies ID tokens (JWKS, iss, aud, exp).
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface GoogleEndpoints {
  authorization: string;
  token: string;
  jwks: JWTVerifyGetKey;
  issuers: string[];
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  jwks: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};

/** Identity scopes only; Google service scopes are requested in P5 (FR-GGL-04). */
export const LOGIN_SCOPES = ['openid', 'email', 'profile'];

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture?: string;
}

export interface TokenResponse {
  idToken: string;
  accessToken?: string;
  refreshToken?: string;
  scope?: string;
  expiresIn?: number;
}

export class GoogleOidc {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private ep: GoogleEndpoints = GOOGLE_ENDPOINTS,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string; scopes: string[]; nonce?: string; consent?: boolean }): string {
    const u = new URL(this.ep.authorization);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', p.scopes.join(' '));
    u.searchParams.set('state', p.state);
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('include_granted_scopes', 'true');
    if (p.consent) u.searchParams.set('prompt', 'consent');
    if (p.nonce) u.searchParams.set('nonce', p.nonce);
    return u.toString();
  }

  async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    });
    const r = await this.fetchImpl(this.ep.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || typeof j.id_token !== 'string') throw new AuthError('google_exchange_failed', typeof j.error === 'string' ? j.error : `status ${r.status}`);
    return {
      idToken: j.id_token,
      accessToken: typeof j.access_token === 'string' ? j.access_token : undefined,
      refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : undefined,
      scope: typeof j.scope === 'string' ? j.scope : undefined,
      expiresIn: typeof j.expires_in === 'number' ? j.expires_in : undefined,
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number; scope?: string }> {
    const body = new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
    const r = await this.fetchImpl(this.ep.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok || typeof j.access_token !== 'string') throw new AuthError('google_refresh_failed', typeof j.error === 'string' ? j.error : `status ${r.status}`);
    return { accessToken: j.access_token, expiresIn: typeof j.expires_in === 'number' ? j.expires_in : 3600, scope: typeof j.scope === 'string' ? j.scope : undefined };
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.ep.jwks, { issuer: this.ep.issuers, audience: this.clientId, algorithms: ['RS256'], clockTolerance: 30 }));
    } catch (e) {
      throw new AuthError('invalid_id_token', (e as Error).message);
    }
    if (typeof payload.sub !== 'string' || !payload.sub) throw new AuthError('invalid_id_token', 'missing sub');
    if (typeof payload.email !== 'string') throw new AuthError('invalid_id_token', 'missing email');
    return {
      sub: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : payload.email,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    };
  }
}

export class AuthError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
  }
}
