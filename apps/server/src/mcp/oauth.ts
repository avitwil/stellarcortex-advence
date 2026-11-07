// OAuth 2.1 client for remote MCP servers (FR-MCP-03, DL-057): the SDK runs discovery
// (RFC 9728 protected resource metadata, RFC 8414 / OIDC), resource indicators (RFC 8707) and
// the `iss` check (RFC 9207); this provider stores its state sealed per MCP server, keys client
// registrations and tokens by authorization server, and hands the authorization URL to the user
// instead of opening a browser on the server.
import type { OAuthClientInformationContext, OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/client';
import { DESKTOP_OAUTH_REDIRECT } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { getMeta } from '../db.js';
import { newToken } from '../ids.js';

type Stored = Parameters<NonNullable<OAuthClientProvider['saveClientInformation']>>[0];
type Tokens = Parameters<OAuthClientProvider['saveTokens']>[0];

interface Body {
  clients: Record<string, Stored>;
  tokens: Record<string, Tokens>;
  lastIssuer: string | null;
  verifier: string | null;
  discovery: OAuthDiscoveryState | null;
  state: string | null;
  authUrl: string | null;
}

const EMPTY: Body = { clients: {}, tokens: {}, lastIssuer: null, verifier: null, discovery: null, state: null, authUrl: null };

export const CLIENT_METADATA: OAuthClientMetadata = {
  client_name: 'StellarCortex Advence',
  redirect_uris: [DESKTOP_OAUTH_REDIRECT],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  application_type: 'native',
} as OAuthClientMetadata;

export class SealedOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;

  constructor(private ctx: AppContext, private serverId: string, private preregistered: { clientId: string; clientSecret?: string } | null) {
    const cimd = getMeta(ctx.db, 'mcp.clientMetadataUrl');
    if (cimd && !preregistered) this.clientMetadataUrl = cimd;
  }

  private load(): Body {
    const r = this.ctx.db.prepare('SELECT body FROM mcp_auth WHERE server_id = ?').get(this.serverId) as { body: Buffer } | undefined;
    if (!r) return structuredClone(EMPTY);
    return { ...EMPTY, ...(JSON.parse(this.ctx.crypto.openContent(r.body, `mcp-auth:${this.serverId}`)) as Partial<Body>) };
  }

  private save(fn: (b: Body) => void): void {
    const b = this.load();
    fn(b);
    const sealed = this.ctx.crypto.sealContent(JSON.stringify(b), `mcp-auth:${this.serverId}`);
    this.ctx.db
      .prepare('INSERT INTO mcp_auth(server_id, body, updated_at) VALUES(?,?,?) ON CONFLICT(server_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at')
      .run(this.serverId, sealed, Date.now());
  }

  get redirectUrl(): string {
    return DESKTOP_OAUTH_REDIRECT;
  }

  get clientMetadata(): OAuthClientMetadata {
    return CLIENT_METADATA;
  }

  state(): string {
    const s = newToken(24);
    this.save((b) => (b.state = s));
    return s;
  }

  clientInformation(ctx?: OAuthClientInformationContext): Stored | undefined {
    // A pre-registered client belongs to the server's own authorization server, whichever it is.
    if (this.preregistered) return { client_id: this.preregistered.clientId, ...(this.preregistered.clientSecret ? { client_secret: this.preregistered.clientSecret } : {}), ...(ctx ? { issuer: ctx.issuer } : {}) } as Stored;
    return ctx ? this.load().clients[ctx.issuer] : undefined;
  }

  saveClientInformation(info: Stored, ctx?: OAuthClientInformationContext): void {
    if (ctx) this.save((b) => (b.clients[ctx.issuer] = info));
  }

  tokens(ctx?: OAuthClientInformationContext): Tokens | undefined {
    const b = this.load();
    if (ctx) return b.tokens[ctx.issuer];
    return b.lastIssuer ? b.tokens[b.lastIssuer] : undefined;
  }

  saveTokens(tokens: Tokens, ctx?: OAuthClientInformationContext): void {
    this.save((b) => {
      const issuer = ctx?.issuer ?? b.lastIssuer ?? 'unknown';
      b.tokens[issuer] = tokens;
      b.lastIssuer = issuer;
      b.authUrl = null;
    });
  }

  redirectToAuthorization(url: URL): void {
    this.save((b) => (b.authUrl = url.href));
  }

  saveCodeVerifier(v: string): void {
    this.save((b) => (b.verifier = v));
  }

  codeVerifier(): string {
    const v = this.load().verifier;
    if (!v) throw new Error('no_code_verifier');
    return v;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.save((b) => (b.discovery = state));
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.load().discovery ?? undefined;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this.save((b) => {
      if (scope === 'all' || scope === 'client') b.clients = {};
      if (scope === 'all' || scope === 'tokens') {
        b.tokens = {};
        b.lastIssuer = null;
      }
      if (scope === 'all' || scope === 'verifier') b.verifier = null;
      if (scope === 'all' || scope === 'discovery') b.discovery = null;
    });
  }

  /** The authorization URL waiting for the user, if a sign-in is pending. */
  pendingUrl(): string | null {
    return this.load().authUrl;
  }

  /** The state the pending authorization URL carries; the callback must match it. */
  expectedState(): string | null {
    return this.load().state;
  }

  signedIn(): boolean {
    const b = this.load();
    return Boolean(b.lastIssuer && b.tokens[b.lastIssuer]);
  }

  clear(): void {
    this.ctx.db.prepare('DELETE FROM mcp_auth WHERE server_id = ?').run(this.serverId);
  }
}
