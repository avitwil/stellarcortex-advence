// MCP client for Bots (FR-MCP-01/02/03/05). Each server is either a command run inside the Bot's
// own computer over stdio, or a remote Streamable HTTP endpoint. Connections negotiate the
// 2026-07-28 revision (server/discover) and fall back to 2025-11-25 (initialize). Tools are offered
// to the Bots the user enabled, filtered by the per-server allowlist. Elicitation (form and URL
// mode, pushed or as input_required rounds) goes to the user in the chat; task-supporting tools
// run through the tasks extension (tasks/get polling). Configurations and OAuth state are sealed.
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Bot, McpAuthFinish, McpServer, McpServerCreate, McpServerPatch, McpToolInfo, User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import type { Bots } from '../chat/bots.js';
import type { ToolCtx, ToolProvider } from '../chat/runtime.js';
import type { ComputerManager } from '../computer/manager.js';
import type { ModelMessage, ToolCall, ToolSpec } from '../models/types.js';
import { HttpError } from '../http.js';
import { newId } from '../ids.js';
import { InputBroker, type ElicitParams } from './inputs.js';
import { SealedOAuthProvider } from './oauth.js';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
const IDLE_MS = 10 * 60_000;
const TOOLS_TTL_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_RESULT_CHARS = 60_000;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_REAUTH = 3;

interface Config {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  oauthClient?: { clientId: string; clientSecret?: string };
  bots: string[];
  allow: string[] | null;
}

interface Row { id: string; user_id: string; config: Buffer; enabled: number; created_at: number }

interface RemoteTool { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown>; execution?: { taskSupport?: string } }

interface Conn {
  client: Client;
  transport: Transport;
  ready: Promise<void>;
  lastUsed: number;
  tools: RemoteTool[] | null;
  toolsAt: number;
  resources: number;
  prompts: number;
  /** the last call in flight, to place pushed elicitations that arrive outside its async context */
  active: CallScope | null;
}

interface CallScope { userId: string; botId: string | null; convId: string | null; signal?: AbortSignal }

interface Status { status: McpServer['status']; error: string | null; era: 'modern' | 'legacy' | null; tools: McpToolInfo[]; resources: number; prompts: number }

const LooseResult = z.looseObject({});
const TaskState = z.looseObject({ taskId: z.string(), status: z.string(), pollIntervalMs: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() });

/** Hosts a member may not point the server at (they would reach the owner's network). */
function privateHost(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd]/.test(host) || host.startsWith('fe80') || host.startsWith('::ffff:');
  return false;
}

/** Tool names the model sees: mcp_<server>_<tool>, within provider limits. */
export function toolName(server: string, tool: string): string {
  const slug = (s: string, n: number) => s.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, n) || 'x';
  return `mcp_${slug(server, 16)}_${slug(tool, 40)}`.slice(0, 64);
}

/** Where a task handle is kept on a tools/call result once it has passed the SDK's decoder. */
const TASK_META = 'advence/task';

/**
 * The SDK decodes only "complete" and "input_required" results. A tools/call answered with a task
 * handle (tasks extension) is handed on as an empty complete result carrying the handle in _meta,
 * and callTool() follows it. The accessor keeps the transport's own class (and its instanceof).
 */
function taskAware<T extends Transport>(t: T): T {
  let handler: Transport['onmessage'];
  Object.defineProperty(t, 'onmessage', {
    configurable: true,
    get: () => handler && ((msg: JSONRPCMessage, extra?: unknown) => (handler as (m: JSONRPCMessage, e?: unknown) => void)(liftTask(msg), extra)),
    set: (fn: Transport['onmessage']) => {
      handler = fn;
    },
  });
  return t;
}

function liftTask(msg: JSONRPCMessage): JSONRPCMessage {
  const r = (msg as { result?: Record<string, unknown> }).result;
  if (!r || r.resultType !== 'task' || typeof r.taskId !== 'string') return msg;
  const { resultType: _t, content: _c, _meta, ...task } = r;
  return { ...msg, result: { resultType: 'complete', content: [], _meta: { ...((_meta ?? {}) as object), [TASK_META]: task } } } as JSONRPCMessage;
}

function textOf(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }): { text: string; images: { mime: string; data: string }[] } {
  const parts: string[] = [];
  const images: { mime: string; data: string }[] = [];
  for (const c of (Array.isArray(result.content) ? result.content : []) as { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; mimeType?: string }; uri?: string; name?: string }[]) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image' && c.data && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType ?? '')) images.push({ mime: c.mimeType!, data: c.data });
    else if (c.type === 'resource' && c.resource) parts.push(c.resource.text !== undefined ? `[${c.resource.uri ?? 'resource'}]\n${c.resource.text}` : `[${c.resource.uri ?? 'resource'} (${c.resource.mimeType ?? 'binary'})]`);
    else if (c.type === 'resource_link') parts.push(`[link] ${c.name ?? ''} ${c.uri ?? ''}`.trim());
    else if (c.type === 'audio') parts.push(`[audio ${c.mimeType ?? ''}]`);
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  let text = parts.join('\n\n');
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n… (cut)`;
  return { text, images };
}

export class McpHub implements ToolProvider {
  readonly inputs: InputBroker;
  private conns = new Map<string, Conn>();
  private status = new Map<string, Status>();
  private names = new Map<string, Map<string, { serverId: string; tool: string }>>();
  private als = new AsyncLocalStorage<CallScope>();
  /** sign-ins since the server last accepted a request */
  private reauths = new Map<string, number>();
  private timer: NodeJS.Timeout;

  constructor(private ctx: AppContext, private bots: Bots, private computers: ComputerManager | null, o: { fetch?: typeof fetch } = {}) {
    this.inputs = new InputBroker(ctx);
    this.fetchImpl = o.fetch ?? fetch;
    this.timer = setInterval(() => this.reap(), 60_000);
    this.timer.unref();
  }

  private fetchImpl: typeof fetch;

  // ------------------------------------------------------------------ storage

  private rows(userId: string): Row[] {
    return this.ctx.db.prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY created_at').all(userId) as Row[];
  }

  private config(r: Row): Config {
    return JSON.parse(this.ctx.crypto.openContent(r.config, `mcp:${r.id}`)) as Config;
  }

  private row(user: User, id: string): Row {
    const r = this.ctx.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined;
    if (!r || r.user_id !== user.id) throw new HttpError(404, 'not_found');
    return r;
  }

  private write(id: string, c: Config): void {
    this.ctx.db.prepare('UPDATE mcp_servers SET config = ?, updated_at = ? WHERE id = ?').run(this.ctx.crypto.sealContent(JSON.stringify(c), `mcp:${id}`), Date.now(), id);
  }

  private view(r: Row): McpServer {
    const c = this.config(r);
    const st = this.status.get(r.id);
    const auth = c.transport === 'http' ? new SealedOAuthProvider(this.ctx, r.id, c.oauthClient ?? null) : null;
    return {
      id: r.id,
      name: c.name,
      transport: c.transport,
      command: c.command ?? null,
      url: c.url ?? null,
      envNames: Object.keys(c.env ?? {}),
      headerNames: Object.keys(c.headers ?? {}),
      preregistered: Boolean(c.oauthClient),
      enabled: r.enabled === 1,
      bots: c.bots,
      allow: c.allow,
      status: auth?.pendingUrl() ? 'auth_required' : (st?.status ?? 'unknown'),
      error: st?.error ?? null,
      era: st?.era ?? null,
      signedIn: auth?.signedIn() ?? false,
      tools: st?.tools ?? [],
      resources: st?.resources ?? 0,
      prompts: st?.prompts ?? 0,
      createdAt: r.created_at,
    };
  }

  private checkBots(user: User, ids: string[]): string[] {
    const mine = new Set(this.bots.list(user).map((b) => b.id));
    for (const id of ids) if (!mine.has(id)) throw new HttpError(400, 'unknown_bot');
    return [...new Set(ids)];
  }

  private checkUrl(user: User, raw: string): void {
    const u = new URL(raw);
    if (u.username || u.password) throw new HttpError(400, 'invalid_url');
    if (user.role === 'owner') {
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'invalid_url');
      return;
    }
    // DL-056: members reach only public HTTPS endpoints, never the owner's network.
    if (u.protocol !== 'https:' || privateHost(u.hostname)) throw new HttpError(403, 'mcp_url_not_allowed');
  }

  list(user: User): McpServer[] {
    return this.rows(user.id).map((r) => this.view(r));
  }

  get(user: User, id: string): McpServer {
    return this.view(this.row(user, id));
  }

  create(user: User, b: McpServerCreate): McpServer {
    if (b.transport === 'http') this.checkUrl(user, b.url!);
    const c: Config = { name: b.name, transport: b.transport, bots: this.checkBots(user, b.bots), allow: b.allow };
    if (b.transport === 'stdio') {
      c.command = b.command!;
      if (b.env) c.env = b.env;
    } else {
      c.url = b.url!;
      if (b.headers) c.headers = b.headers;
      if (b.oauthClient) c.oauthClient = b.oauthClient;
    }
    const id = newId('mcp');
    const now = Date.now();
    this.ctx.db.prepare('INSERT INTO mcp_servers(id, user_id, config, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(id, user.id, this.ctx.crypto.sealContent(JSON.stringify(c), `mcp:${id}`), 1, now, now);
    return this.get(user, id);
  }

  patch(user: User, id: string, p: McpServerPatch): McpServer {
    const r = this.row(user, id);
    const c = this.config(r);
    if (p.name !== undefined) c.name = p.name;
    if (p.bots !== undefined) c.bots = this.checkBots(user, p.bots);
    if (p.allow !== undefined) c.allow = p.allow;
    this.write(id, c);
    if (p.enabled !== undefined) {
      this.ctx.db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(p.enabled ? 1 : 0, id);
      if (!p.enabled) void this.disconnect(id);
    }
    return this.get(user, id);
  }

  async remove(user: User, id: string): Promise<void> {
    this.row(user, id);
    await this.disconnect(id);
    this.ctx.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    this.status.delete(id);
  }

  // ------------------------------------------------------------------ connections

  private key(serverId: string, c: Config, botId: string | null): string {
    return c.transport === 'stdio' ? `${serverId}:${botId ?? ''}` : serverId;
  }

  private async transportFor(user: User, r: Row, c: Config, bot: Bot | null): Promise<Transport> {
    if (c.transport === 'stdio') {
      if (!bot) throw new HttpError(400, 'bot_required');
      const m = this.computers;
      if (!m || !(await m.runtimeInfo(true)).available) throw new HttpError(503, 'computer_unavailable');
      await m.ensure({ id: bot.id, userId: user.id });
      const cmd = m.interactive(bot.id, ['sh', '-lc', c.command!], c.env ?? {});
      return taskAware(new StdioClientTransport({ command: cmd.command, args: cmd.args, env: cmd.env, cwd: cmd.cwd, stderr: 'ignore' }));
    }
    const auth = new SealedOAuthProvider(this.ctx, r.id, c.oauthClient ?? null);
    const member = user.role !== 'owner';
    const guarded: typeof fetch = async (input, init) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (member && (u.protocol !== 'https:' || privateHost(u.hostname))) throw new Error('mcp_url_not_allowed');
      return this.fetchImpl(input, { ...init, redirect: member ? 'error' : init?.redirect });
    };
    return taskAware(new StreamableHTTPClientTransport(new URL(c.url!), { authProvider: auth, requestInit: { headers: c.headers ?? {} }, fetch: guarded }));
  }

  private newClient(serverId: string, serverName: string, key: string): Client {
    const client = new Client(
      { name: 'stellarcortex-advence', version: '1.0.0' },
      {
        capabilities: { elicitation: { form: {}, url: {} }, extensions: { [TASKS_EXTENSION]: {} } } as never,
        versionNegotiation: { mode: 'auto', probe: { timeoutMs: 15_000 } },
        inputRequired: { maxRounds: 8 },
      },
    );
    client.setRequestHandler('elicitation/create', async (req) => {
      const scope = this.als.getStore() ?? this.conns.get(key)?.active ?? null;
      if (!scope) return { action: 'decline' as const };
      const p = req.params as unknown as ElicitParams;
      const a = await this.inputs.ask({ userId: scope.userId, serverId, serverName, botId: scope.botId, convId: scope.convId }, p, scope.signal);
      return a.action === 'accept' && a.content ? { action: 'accept' as const, content: a.content as Record<string, string | number | boolean | string[]> } : { action: a.action };
    });
    try {
      client.setNotificationHandler('notifications/tools/list_changed', () => {
        const c = this.conns.get(key);
        if (c) c.toolsAt = 0;
      });
    } catch {
      /* not offered on this era */
    }
    return client;
  }

  private async conn(user: User, r: Row, c: Config, bot: Bot | null): Promise<Conn> {
    const key = this.key(r.id, c, bot?.id ?? null);
    const had = this.conns.get(key);
    if (had) {
      await had.ready;
      had.lastUsed = Date.now();
      return had;
    }
    const client = this.newClient(r.id, c.name, key);
    const transport = await this.transportFor(user, r, c, bot);
    const entry: Conn = { client, transport, ready: Promise.resolve(), lastUsed: Date.now(), tools: null, toolsAt: 0, resources: 0, prompts: 0, active: null };
    entry.ready = client.connect(transport).then(
      () => this.setStatus(r.id, { status: 'ok', error: null, era: client.getProtocolEra() ?? null }),
      (e: unknown) => {
        this.conns.delete(key);
        void transport.close().catch(() => undefined);
        if (e instanceof UnauthorizedError) {
          this.authRequired(r.id, c);
          throw new HttpError(401, 'mcp_auth_required');
        }
        this.setStatus(r.id, { status: 'error', error: (e as Error).message.slice(0, 300) });
        throw new HttpError(502, 'mcp_unreachable');
      },
    );
    this.conns.set(key, entry);
    await entry.ready;
    return entry;
  }

  private setStatus(id: string, p: Partial<Status>): void {
    const cur = this.status.get(id) ?? { status: 'unknown', error: null, era: null, tools: [], resources: 0, prompts: 0 };
    this.status.set(id, { ...cur, ...p });
  }

  private async disconnect(serverId: string): Promise<void> {
    for (const [k, c] of this.conns) {
      if (k === serverId || k.startsWith(`${serverId}:`)) {
        this.conns.delete(k);
        await c.client.close().catch(() => undefined);
      }
    }
  }

  private reap(): void {
    const now = Date.now();
    for (const [k, c] of this.conns) {
      if (now - c.lastUsed > IDLE_MS && !c.active) {
        this.conns.delete(k);
        void c.client.close().catch(() => undefined);
      }
    }
  }

  private async loadLists(id: string, conn: Conn, force = false): Promise<RemoteTool[]> {
    if (conn.tools && !force && Date.now() - conn.toolsAt < TOOLS_TTL_MS) return conn.tools;
    const caps = conn.client.getServerCapabilities() ?? {};
    const tools: RemoteTool[] = [];
    if (caps.tools) {
      let cursor: string | undefined;
      do {
        const page = await conn.client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(page.tools as RemoteTool[]));
        cursor = page.nextCursor;
      } while (cursor && tools.length < MAX_TOOLS_PER_SERVER);
    }
    conn.resources = caps.resources ? (await conn.client.listResources().catch(() => ({ resources: [] }))).resources.length : 0;
    conn.prompts = caps.prompts ? (await conn.client.listPrompts().catch(() => ({ prompts: [] }))).prompts.length : 0;
    conn.tools = tools.slice(0, MAX_TOOLS_PER_SERVER);
    conn.toolsAt = Date.now();
    this.reauths.delete(id);
    this.setStatus(id, {
      tools: conn.tools.map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}), ...(t.description ? { description: t.description.slice(0, 500) } : {}), task: ['optional', 'required'].includes(t.execution?.taskSupport ?? '') })),
      resources: conn.resources,
      prompts: conn.prompts,
    });
    return conn.tools;
  }

  /** Connects (for stdio servers, in the given Bot's computer) and lists what the server offers. */
  async check(user: User, id: string, botId?: string): Promise<McpServer> {
    const r = this.row(user, id);
    const c = this.config(r);
    const bot = botId ? this.bots.owned(user, botId) : c.transport === 'stdio' ? (this.bots.list(user).find((b) => c.bots.includes(b.id)) ?? null) : null;
    if (c.transport === 'stdio' && !bot) throw new HttpError(409, 'enable_for_a_bot_first');
    const conn = await this.conn(user, r, c, bot);
    try {
      await this.loadLists(r.id, conn, true);
    } catch (e) {
      throw await this.signedOut(r.id, e);
    }
    return this.get(user, id);
  }

  /** A request after connecting was refused for lack of sign-in (expired, revoked or step-up). */
  private async signedOut(id: string, e: unknown): Promise<unknown> {
    if (!(e instanceof UnauthorizedError)) return e;
    await this.disconnect(id);
    const r = this.ctx.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined;
    if (r) this.authRequired(id, this.config(r));
    return new HttpError(401, 'mcp_auth_required');
  }

  /**
   * The server wants a (new) sign-in. After MAX_REAUTH sign-ins in a row that did not lead to a
   * single accepted request, the sign-in is withdrawn and the server shows an error instead, so a
   * server that keeps refusing every token cannot send the user round in circles.
   */
  private authRequired(id: string, c: Config): void {
    if ((this.reauths.get(id) ?? 0) >= MAX_REAUTH) {
      if (c.transport === 'http') new SealedOAuthProvider(this.ctx, id, c.oauthClient ?? null).dropPending();
      this.setStatus(id, { status: 'error', error: 'The server refused access after repeated sign-ins. Check the account’s permissions, then sign out and in again.' });
      return;
    }
    this.setStatus(id, { status: 'auth_required', error: null });
  }

  // ------------------------------------------------------------------ OAuth (FR-MCP-03)

  authUrl(user: User, id: string): string | null {
    const r = this.row(user, id);
    const c = this.config(r);
    if (c.transport !== 'http') throw new HttpError(400, 'not_http');
    return new SealedOAuthProvider(this.ctx, r.id, c.oauthClient ?? null).pendingUrl();
  }

  async finishAuth(user: User, id: string, b: McpAuthFinish): Promise<McpServer> {
    const r = this.row(user, id);
    const c = this.config(r);
    if (c.transport !== 'http') throw new HttpError(400, 'not_http');
    const params = new URLSearchParams();
    if (b.callbackUrl) {
      const u = new URL(b.callbackUrl);
      u.searchParams.forEach((v, k) => params.set(k, v));
    }
    if (b.code) params.set('code', b.code);
    if (b.state) params.set('state', b.state);
    if (b.iss) params.set('iss', b.iss);
    const auth = new SealedOAuthProvider(this.ctx, r.id, c.oauthClient ?? null);
    const expected = auth.expectedState();
    if (!expected || params.get('state') !== expected) throw new HttpError(400, 'invalid_state');
    if (!params.get('code')) throw new HttpError(400, 'invalid_code');
    const t = (await this.transportFor(user, r, c, null)) as StreamableHTTPClientTransport;
    try {
      await t.finishAuth(params);
    } catch (e) {
      this.ctx.log.warn({ server: r.id, err: (e as Error).name }, 'mcp sign-in failed');
      throw new HttpError(400, 'mcp_auth_failed');
    } finally {
      await t.close().catch(() => undefined);
    }
    await this.disconnect(r.id);
    this.reauths.set(r.id, (this.reauths.get(r.id) ?? 0) + 1);
    this.setStatus(r.id, { status: 'unknown', error: null });
    return this.get(user, id);
  }

  signOut(user: User, id: string): McpServer {
    const r = this.row(user, id);
    new SealedOAuthProvider(this.ctx, r.id, null).clear();
    this.reauths.delete(r.id);
    void this.disconnect(r.id);
    this.setStatus(r.id, { status: 'unknown', error: null });
    return this.get(user, id);
  }

  // ------------------------------------------------------------------ tools for Bots

  private enabledFor(user: User, bot: Bot): { r: Row; c: Config }[] {
    return this.rows(user.id)
      .filter((r) => r.enabled === 1)
      .map((r) => ({ r, c: this.config(r) }))
      .filter(({ c }) => c.bots.includes(bot.id));
  }

  async prepare(user: User, bot: Bot, signal: AbortSignal): Promise<void> {
    await Promise.all(
      this.enabledFor(user, bot).map(async ({ r, c }) => {
        if (signal.aborted || this.signInPending(r, c)) return;
        try {
          const conn = await this.conn(user, r, c, bot);
          await this.loadLists(r.id, conn).catch(async (e: unknown) => {
            throw await this.signedOut(r.id, e);
          });
        } catch {
          /* the server shows its status in Settings; the Bot simply lacks its tools */
        }
      }),
    );
  }

  /**
   * The user has a sign-in open for this server. Bots leave it alone until it is finished: a new
   * connection attempt would start another authorization and void the one the user is completing.
   */
  private signInPending(r: Row, c: Config): boolean {
    return c.transport === 'http' && new SealedOAuthProvider(this.ctx, r.id, c.oauthClient ?? null).pendingUrl() !== null;
  }

  private allowed(c: Config, tool: string): boolean {
    return c.allow === null || c.allow.includes(tool);
  }

  specs(user: User, bot: Bot): ToolSpec[] {
    const out: ToolSpec[] = [];
    const names = new Map<string, { serverId: string; tool: string }>();
    let withResources = false;
    let withPrompts = false;
    for (const { r, c } of this.enabledFor(user, bot)) {
      const conn = this.conns.get(this.key(r.id, c, bot.id));
      if (!conn?.tools) continue;
      if (conn.resources) withResources = true;
      if (conn.prompts) withPrompts = true;
      for (const t of conn.tools) {
        if (!this.allowed(c, t.name)) continue;
        let n = toolName(c.name, t.name);
        for (let i = 2; names.has(n); i++) n = `${n.slice(0, 60)}_${i}`;
        names.set(n, { serverId: r.id, tool: t.name });
        const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} };
        out.push({ name: n, description: `[MCP: ${c.name}] ${(t.description ?? t.title ?? t.name).slice(0, 1000)}`, parameters: schema });
      }
    }
    if (withResources) {
      out.push({ name: 'mcp_resources', description: 'List the resources (files, records, documents) your MCP servers offer.', parameters: { type: 'object', properties: { server: { type: 'string', description: 'Server name; all servers if omitted.' } }, additionalProperties: false } });
      out.push({ name: 'mcp_read_resource', description: 'Read one resource from an MCP server by its URI.', parameters: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } }, required: ['server', 'uri'], additionalProperties: false } });
    }
    if (withPrompts) {
      out.push({ name: 'mcp_prompts', description: 'List the prompt templates your MCP servers offer.', parameters: { type: 'object', properties: { server: { type: 'string' } }, additionalProperties: false } });
      out.push({ name: 'mcp_get_prompt', description: 'Get a prompt template from an MCP server, filled with arguments.', parameters: { type: 'object', properties: { server: { type: 'string' }, name: { type: 'string' }, arguments: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['server', 'name'], additionalProperties: false } });
    }
    this.names.set(`${user.id}:${bot.id}`, names);
    return out;
  }

  handles(name: string): boolean {
    return name.startsWith('mcp_');
  }

  system(user: User, bot: Bot): string | null {
    const servers = this.enabledFor(user, bot).map(({ c }) => c.name);
    if (!servers.length) return null;
    return `MCP servers you can use: ${servers.join(', ')}. Their tools start with "mcp_". A server may ask the user for input during a call; that happens in the chat, and you get the outcome in the tool result.`;
  }

  private byName(user: User, bot: Bot, server: string): { r: Row; c: Config } {
    const want = server.trim().toLocaleLowerCase();
    const hit = this.enabledFor(user, bot).find(({ r, c }) => r.id === server || c.name.toLocaleLowerCase() === want);
    if (!hit) throw new HttpError(404, 'mcp_server_not_found');
    return hit;
  }

  async run(c: ToolCtx, call: ToolCall): Promise<ModelMessage> {
    const ok = (content: string, images?: { mime: string; data: string }[]): ModelMessage => ({ role: 'tool', toolCallId: call.id, content: content || '(no output)', ...(images?.length ? { images: images.map((i) => ({ type: 'image' as const, mime: i.mime, dataB64: i.data })) } : {}) });
    const fail = (content: string): ModelMessage => ({ role: 'tool', toolCallId: call.id, content, isError: true });
    const input = (call.input ?? {}) as Record<string, unknown>;
    const scope: CallScope = { userId: c.user.id, botId: c.bot.id, convId: c.convId || null, signal: c.signal };
    try {
      if (['mcp_resources', 'mcp_read_resource', 'mcp_prompts', 'mcp_get_prompt'].includes(call.name)) return await this.als.run(scope, () => this.runMeta(c, call.name, input, ok));
      const target = this.names.get(`${c.user.id}:${c.bot.id}`)?.get(call.name);
      if (!target) return fail(`Unknown tool ${call.name}.`);
      const r = this.row(c.user, target.serverId);
      const conf = this.config(r);
      if (r.enabled !== 1 || !conf.bots.includes(c.bot.id) || !this.allowed(conf, target.tool)) return fail('This MCP tool is not enabled for you.');
      if (this.signInPending(r, conf)) throw new HttpError(401, 'mcp_auth_required');
      const conn = await this.conn(c.user, r, conf, c.bot);
      const tools = await this.loadLists(r.id, conn);
      const def = tools.find((t) => t.name === target.tool);
      if (!def) return fail('The MCP server no longer offers this tool.');
      conn.active = scope;
      try {
        const signal = AbortSignal.any([c.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]);
        const result = await this.als.run(scope, () => this.callTool(conn, { id: r.id, name: conf.name }, def, input, signal));
        this.reauths.delete(r.id);
        const { text, images } = textOf(result);
        return result.isError ? fail(text || 'The tool reported an error.') : ok(text, images);
      } finally {
        conn.active = null;
        conn.lastUsed = Date.now();
      }
    } catch (caught) {
      const target = this.names.get(`${c.user.id}:${c.bot.id}`)?.get(call.name);
      const e = target ? await this.signedOut(target.serverId, caught) : caught;
      if (e instanceof HttpError) {
        if (e.code === 'mcp_auth_required') return fail('This MCP server needs the user to sign in first (Settings → MCP).');
        if (e.code === 'computer_unavailable') return fail('This MCP server runs in your computer, which is not available right now.');
        if (e.code === 'mcp_server_not_found') return fail('No such MCP server is enabled for you.');
        return fail(`The MCP server could not be reached (${e.code}).`);
      }
      if (c.signal.aborted) return fail('Stopped.');
      return fail(`The MCP call failed: ${(e as Error).message.slice(0, 300)}`);
    }
  }

  /** Calls a tool. A server may answer with a task (tasks extension, SEP-2663), which is followed to its end. */
  private async callTool(conn: Conn, server: { id: string; name: string }, def: RemoteTool, args: Record<string, unknown>, signal: AbortSignal): Promise<{ content?: unknown; structuredContent?: unknown; isError?: boolean }> {
    const first = (await conn.client.callTool({ name: def.name, arguments: args }, { signal, timeout: CALL_TIMEOUT_MS })) as Record<string, unknown>;
    const handle = ((first._meta ?? {}) as Record<string, unknown>)[TASK_META] as { taskId?: unknown; pollIntervalMs?: unknown } | undefined;
    if (!handle || typeof handle.taskId !== 'string') return first as never;
    const taskId = handle.taskId;
    const cancel = () => void conn.client.request({ method: 'tasks/cancel', params: { taskId } } as never, LooseResult).catch(() => undefined);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      let wait = Math.min(Math.max(Number(handle.pollIntervalMs) || 1000, 200), 30_000);
      const answered = new Set<string>();
      for (;;) {
        if (signal.aborted) throw new Error('aborted');
        await new Promise((r) => setTimeout(r, wait));
        const t = await conn.client.request({ method: 'tasks/get', params: { taskId } } as never, TaskState, { signal });
        if (t.status === 'completed') return (t.result ?? { content: [] }) as never;
        if (t.status === 'failed') return { content: [{ type: 'text', text: `The task failed: ${JSON.stringify(t.error ?? {}).slice(0, 500)}` }], isError: true };
        if (t.status === 'cancelled') return { content: [{ type: 'text', text: 'The task was cancelled.' }], isError: true };
        if (t.status === 'input_required') {
          const reqs = ((t as Record<string, unknown>).inputRequests ?? {}) as Record<string, { method?: string; params?: ElicitParams }>;
          const pending = Object.entries(reqs).filter(([k]) => !answered.has(k));
          if (pending.length) {
            const scope = this.als.getStore();
            const responses: Record<string, unknown> = {};
            for (const [k, v] of pending) {
              answered.add(k);
              responses[k] = v.method === 'elicitation/create' && v.params && scope
                ? await this.inputs.ask({ userId: scope.userId, serverId: server.id, serverName: server.name, botId: scope.botId, convId: scope.convId }, v.params, signal)
                : { action: 'decline' };
            }
            await conn.client.request({ method: 'tasks/update', params: { taskId, inputResponses: responses } } as never, LooseResult, { signal });
          }
        } else answered.clear();
        wait = Math.min(Math.max(Number(t.pollIntervalMs) || wait, 200), 30_000);
      }
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  private async runMeta(c: ToolCtx, name: string, input: Record<string, unknown>, ok: (s: string) => ModelMessage): Promise<ModelMessage> {
    const servers = input.server ? [this.byName(c.user, c.bot, String(input.server))] : this.enabledFor(c.user, c.bot);
    if (name === 'mcp_resources' || name === 'mcp_prompts') {
      const lines: string[] = [];
      for (const { r, c: conf } of servers) {
        const conn = await this.conn(c.user, r, conf, c.bot).catch(() => null);
        if (!conn) continue;
        if (name === 'mcp_resources') {
          const l = await conn.client.listResources().catch(() => ({ resources: [] }));
          for (const x of l.resources.slice(0, 200)) lines.push(`${conf.name}\t${x.uri}\t${x.name}${x.description ? ` — ${x.description.slice(0, 200)}` : ''}`);
        } else {
          const l = await conn.client.listPrompts().catch(() => ({ prompts: [] }));
          for (const x of l.prompts.slice(0, 200)) lines.push(`${conf.name}\t${x.name}${x.description ? ` — ${x.description.slice(0, 200)}` : ''}${x.arguments?.length ? ` (arguments: ${x.arguments.map((a) => a.name).join(', ')})` : ''}`);
        }
      }
      return ok(lines.join('\n') || 'Nothing offered.');
    }
    const { r, c: conf } = servers[0]!;
    const conn = await this.conn(c.user, r, conf, c.bot);
    if (name === 'mcp_read_resource') {
      const res = await conn.client.readResource({ uri: String(input.uri ?? '') }, { signal: c.signal });
      return ok(res.contents.map((x) => ('text' in x && typeof x.text === 'string' ? x.text : `[${x.uri} (${x.mimeType ?? 'binary'})]`)).join('\n\n').slice(0, MAX_RESULT_CHARS));
    }
    const args = Object.fromEntries(Object.entries((input.arguments ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    const p = await conn.client.getPrompt({ name: String(input.name ?? ''), arguments: args }, { signal: c.signal });
    return ok(p.messages.map((m) => `${m.role}: ${m.content.type === 'text' ? m.content.text : `[${m.content.type}]`}`).join('\n\n').slice(0, MAX_RESULT_CHARS));
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.inputs.close();
    await Promise.all([...this.conns.values()].map((c) => c.client.close().catch(() => undefined)));
    this.conns.clear();
  }
}
