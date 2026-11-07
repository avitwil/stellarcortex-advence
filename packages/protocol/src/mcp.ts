// MCP client and server (P5: FR-MCP-01..05) and Google services (FR-GGL-04..06).
import { z } from 'zod';

const ENV = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;

export const McpTransport = z.enum(['stdio', 'http']);
export type McpTransport = z.infer<typeof McpTransport>;

/** stdio: a command line run inside the Bot's computer. http: a Streamable HTTP endpoint. */
export const McpServerCreate = z.object({
  name: z.string().trim().min(1).max(64),
  transport: McpTransport,
  command: z.string().trim().min(1).max(2000).optional(),
  url: z.string().url().max(2000).optional(),
  /** secret values; stdio: environment variables, http: request headers */
  env: z.record(z.string().regex(ENV), z.string().max(4000)).optional(),
  headers: z.record(z.string().regex(HEADER), z.string().max(4000)).optional(),
  /** a client registered ahead of time with the server's authorization server */
  oauthClient: z.object({ clientId: z.string().min(1).max(500), clientSecret: z.string().max(500).optional() }).optional(),
  bots: z.array(z.string().max(64)).max(200).default([]),
  /** tool names the Bots may call; null = all of them */
  allow: z.array(z.string().max(128)).max(500).nullable().default(null),
}).strict().superRefine((v, ctx) => {
  if (v.transport === 'stdio' && !v.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'required' });
  if (v.transport === 'http' && !v.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'required' });
  if (v.transport === 'stdio' && (v.url || v.headers || v.oauthClient)) ctx.addIssue({ code: 'custom', path: ['transport'], message: 'stdio_fields' });
  if (v.transport === 'http' && (v.command || v.env)) ctx.addIssue({ code: 'custom', path: ['transport'], message: 'http_fields' });
});
export type McpServerCreate = z.infer<typeof McpServerCreate>;

export const McpServerPatch = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  bots: z.array(z.string().max(64)).max(200).optional(),
  allow: z.array(z.string().max(128)).max(500).nullable().optional(),
}).strict();
export type McpServerPatch = z.infer<typeof McpServerPatch>;

export const McpToolInfo = z.object({ name: z.string(), title: z.string().optional(), description: z.string().optional(), task: z.boolean().optional() });
export type McpToolInfo = z.infer<typeof McpToolInfo>;

export const McpStatus = z.enum(['unknown', 'ok', 'error', 'auth_required']);
export type McpStatus = z.infer<typeof McpStatus>;

export const McpServer = z.object({
  id: z.string(),
  name: z.string(),
  transport: McpTransport,
  command: z.string().nullable(),
  url: z.string().nullable(),
  envNames: z.array(z.string()),
  headerNames: z.array(z.string()),
  preregistered: z.boolean(),
  enabled: z.boolean(),
  bots: z.array(z.string()),
  allow: z.array(z.string()).nullable(),
  status: McpStatus,
  error: z.string().nullable(),
  /** 'modern' = 2026-07-28, 'legacy' = 2025-11-25 and earlier */
  era: z.enum(['modern', 'legacy']).nullable(),
  signedIn: z.boolean(),
  tools: z.array(McpToolInfo),
  resources: z.number().int(),
  prompts: z.number().int(),
  createdAt: z.number(),
});
export type McpServer = z.infer<typeof McpServer>;

export const McpCheckRequest = z.object({ botId: z.string().max(64).optional() }).strict();

export const McpAuthStart = z.object({ url: z.string() });
export const McpAuthFinish = z.object({
  /** the full callback URL the browser landed on, or its parts */
  callbackUrl: z.string().max(8000).optional(),
  code: z.string().max(4000).optional(),
  state: z.string().max(500).optional(),
  iss: z.string().max(2000).optional(),
}).strict();
export type McpAuthFinish = z.infer<typeof McpAuthFinish>;

/** A server asking the user for input in the middle of a tool call (elicitation, FR-MCP-02/03). */
export const McpInput = z.object({
  id: z.string(),
  serverId: z.string(),
  serverName: z.string(),
  botId: z.string().nullable(),
  convId: z.string().nullable(),
  mode: z.enum(['form', 'url']),
  message: z.string(),
  /** form mode: flat JSON schema of primitive fields */
  schema: z.record(z.string(), z.unknown()).nullable(),
  /** url mode: shown in full; opened only after the user agrees */
  url: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type McpInput = z.infer<typeof McpInput>;

export const McpInputAnswer = z.object({
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.record(z.string().max(128), z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(1000)).max(100)])).optional(),
}).strict();
export type McpInputAnswer = z.infer<typeof McpInputAnswer>;

/** Access tokens for external MCP clients of this server (FR-MCP-04), owner only. */
export const McpAccessToken = z.object({ id: z.string(), name: z.string(), createdAt: z.number(), lastUsed: z.number().nullable() });
export type McpAccessToken = z.infer<typeof McpAccessToken>;
export const McpAccessTokenCreate = z.object({ name: z.string().trim().min(1).max(64) }).strict();

export const McpServerSelf = z.object({
  /** the endpoint external clients connect to, on this server's TLS port */
  endpoint: z.string(),
  certPem: z.string(),
  tokens: z.array(McpAccessToken),
  /** HTTPS URL of a hosted copy of /oauth/client-metadata.json, used as the OAuth client id */
  clientMetadataUrl: z.string().nullable(),
});
export type McpServerSelf = z.infer<typeof McpServerSelf>;

export const McpSettingsPatch = z.object({ clientMetadataUrl: z.string().url().startsWith('https://').max(2000).nullable() }).strict();

// ---- Google services (FR-GGL-04..06)

export const GoogleService = z.enum(['gmail', 'calendar', 'drive', 'contacts']);
export type GoogleService = z.infer<typeof GoogleService>;

export const GoogleConnection = z.object({
  /** none: never connected; ok; expiring: within a day of the Testing-mode 7-day limit; reconnect */
  state: z.enum(['none', 'ok', 'expiring', 'reconnect']),
  email: z.string().nullable(),
  services: z.array(GoogleService),
  connectedAt: z.number().nullable(),
  /** when Google stops honouring the refresh token (Testing mode), if known */
  expiresAt: z.number().nullable(),
});
export type GoogleConnection = z.infer<typeof GoogleConnection>;

export const GoogleConnectStart = z.object({ redirectUri: z.string(), codeChallenge: z.string().min(43).max(128) }).strict();
export const GoogleConnectFinish = z.object({ code: z.string().min(1).max(4000), state: z.string().min(1).max(200), codeVerifier: z.string().min(43).max(128) }).strict();
