// P5 REST API for MCP (FR-MCP-01..05): the user's MCP servers with per-Bot enablement and tool
// allowlists, OAuth sign-in, pending input requests, and this server's own MCP endpoint (owner).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { McpAccessTokenCreate, McpAuthFinish, McpCheckRequest, McpInputAnswer, McpServerCreate, McpServerPatch, McpSettingsPatch, type McpServerSelf } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { getMeta, setMeta } from '../db.js';
import { HttpError, parse, router, userOf } from '../http.js';
import type { McpHub } from '../mcp/hub.js';
import type { McpTokens } from '../mcp/server.js';
import { CLIENT_METADATA } from '../mcp/oauth.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext, hub: McpHub, tokens: McpTokens): void {
  const route = router(app, ctx);

  route('GET', '/v1/mcp/servers', 'session', (req) => hub.list(userOf(req)));
  route('POST', '/v1/mcp/servers', 'session', (req) => hub.create(userOf(req), parse(McpServerCreate, req.body)));
  route('GET', '/v1/mcp/servers/:id', 'session', (req) => hub.get(userOf(req), params(req).id!));
  route('PATCH', '/v1/mcp/servers/:id', 'session', (req) => hub.patch(userOf(req), params(req).id!, parse(McpServerPatch, req.body)));
  route('DELETE', '/v1/mcp/servers/:id', 'session', async (req) => {
    await hub.remove(userOf(req), params(req).id!);
    return { ok: true };
  });
  route('POST', '/v1/mcp/servers/:id/check', 'session', async (req) => {
    const user = userOf(req);
    const b = parse(McpCheckRequest, req.body ?? {});
    try {
      return await hub.check(user, params(req).id!, b.botId);
    } catch (e) {
      if (e instanceof HttpError && (e.code === 'mcp_auth_required' || e.code === 'mcp_unreachable')) return hub.get(user, params(req).id!);
      throw e;
    }
  });

  // OAuth sign-in (FR-MCP-03): the URL to open on the user's device, then the callback it got.
  route('POST', '/v1/mcp/servers/:id/auth', 'session', async (req) => {
    const user = userOf(req);
    const id = params(req).id!;
    let url = hub.authUrl(user, id);
    if (!url) {
      await hub.check(user, id).catch(() => undefined);
      url = hub.authUrl(user, id);
    }
    if (!url) throw new HttpError(409, 'no_sign_in_needed');
    return { url };
  });
  route('POST', '/v1/mcp/servers/:id/auth/finish', 'session', (req) => hub.finishAuth(userOf(req), params(req).id!, parse(McpAuthFinish, req.body)));
  route('DELETE', '/v1/mcp/servers/:id/auth', 'session', (req) => hub.signOut(userOf(req), params(req).id!));

  // Input a server asked for during a Bot's tool call.
  route('GET', '/v1/mcp/inputs', 'session', (req) => hub.inputs.list(userOf(req).id));
  route('POST', '/v1/mcp/inputs/:id', 'session', (req) => {
    hub.inputs.answer(userOf(req).id, params(req).id!, parse(McpInputAnswer, req.body));
    return { ok: true };
  });

  // This server as an MCP server (FR-MCP-04), owner only.
  const self = (): McpServerSelf => ({
    endpoint: `https://localhost:${(app.server.address() as { port?: number } | null)?.port ?? ctx.config.port}/mcp`,
    certPem: ctx.tls.certPem,
    tokens: [],
    clientMetadataUrl: getMeta(ctx.db, 'mcp.clientMetadataUrl') ?? null,
  });
  route('GET', '/v1/mcp/self', 'owner', (req) => ({ ...self(), tokens: tokens.list(userOf(req)) }));
  route('POST', '/v1/mcp/tokens', 'owner', (req) => tokens.create(userOf(req), parse(McpAccessTokenCreate, req.body).name));
  route('DELETE', '/v1/mcp/tokens/:id', 'owner', (req) => {
    tokens.revoke(userOf(req), params(req).id!);
    return { ok: true };
  });
  route('PATCH', '/v1/mcp/settings', 'owner', (req) => {
    const b = parse(McpSettingsPatch, req.body);
    if (b.clientMetadataUrl === null) ctx.db.prepare("DELETE FROM meta WHERE key = 'mcp.clientMetadataUrl'").run();
    else setMeta(ctx.db, 'mcp.clientMetadataUrl', b.clientMetadataUrl);
    return { ...self(), tokens: tokens.list(userOf(req)) };
  });

  // Client ID Metadata Document (FR-MCP-03, DL-057): its client_id is the HTTPS URL the owner
  // hosts it at. Public, no secrets.
  app.get('/oauth/client-metadata.json', async (_req, reply) => {
    const url = getMeta(ctx.db, 'mcp.clientMetadataUrl');
    if (!url) return reply.code(404).send({ error: 'not_configured' });
    return reply.header('content-type', 'application/json').send({ client_id: url, ...CLIENT_METADATA });
  });
}
