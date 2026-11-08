// This server as an MCP server (FR-MCP-04, DL-058): external MCP clients (for example Claude Code
// on the owner's PC) list and message the owner's Bots, list routines and read the Library, over
// the server's own TLS port at /mcp. Both protocol eras are served per request. Only the owner's
// access tokens (created in Settings, stored as hashes) are accepted.
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { CHAT_EVENTS, type McpAccessToken, type Message, type User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import type { Chat } from '../chat/index.js';
import { HttpError } from '../http.js';
import { hashToken, newId, newToken } from '../ids.js';

const REPLY_TIMEOUT_MS = 5 * 60_000;
export const TOKEN_PREFIX = 'advmcp_';

export interface Routine { id: string; name: string; botId: string | null; schedule: string | null; enabled: boolean }

export class McpTokens {
  constructor(private ctx: AppContext) {}

  list(user: User): McpAccessToken[] {
    const rows = this.ctx.db.prepare('SELECT * FROM mcp_tokens WHERE user_id = ? ORDER BY created_at').all(user.id) as { id: string; name: Buffer; created_at: number; last_used: number | null }[];
    return rows.map((r) => ({ id: r.id, name: this.ctx.crypto.openContent(r.name, `mcp-token:${r.id}`), createdAt: r.created_at, lastUsed: r.last_used }));
  }

  create(user: User, name: string): { token: string; info: McpAccessToken } {
    if (user.role !== 'owner') throw new HttpError(403, 'owner_only');
    const id = newId('mtk');
    const token = `${TOKEN_PREFIX}${newToken(32)}`;
    const now = Date.now();
    this.ctx.db.prepare('INSERT INTO mcp_tokens(id, user_id, token_hash, name, created_at) VALUES(?,?,?,?,?)').run(id, user.id, hashToken(token), this.ctx.crypto.sealContent(name, `mcp-token:${id}`), now);
    return { token, info: { id, name, createdAt: now, lastUsed: null } };
  }

  revoke(user: User, id: string): void {
    const r = this.ctx.db.prepare('DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?').run(id, user.id);
    if (!r.changes) throw new HttpError(404, 'not_found');
  }

  /** The owner a bearer token belongs to, or null. A token whose user is no longer the owner stops working. */
  verify(header: string | undefined): User | null {
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    if (!m || !m[1]!.startsWith(TOKEN_PREFIX)) return null;
    const r = this.ctx.db.prepare('SELECT id, user_id FROM mcp_tokens WHERE token_hash = ?').get(hashToken(m[1]!)) as { id: string; user_id: string } | undefined;
    if (!r) return null;
    const user = this.ctx.identity.getUser(r.user_id);
    if (!user || user.role !== 'owner') return null;
    this.ctx.db.prepare('UPDATE mcp_tokens SET last_used = ? WHERE id = ?').run(Date.now(), r.id);
    return user;
  }
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

/** Sends the owner's message to a Bot's direct chat and waits for the Bot's reply. */
async function messageBot(ctx: AppContext, chat: Chat, user: User, botRef: string, body: string, signal: AbortSignal): Promise<string> {
  const want = botRef.replace(/^@/, '').trim().toLocaleLowerCase();
  const bot = chat.bots.list(user).find((b) => b.id === botRef || b.name.toLocaleLowerCase() === want);
  if (!bot) throw new HttpError(404, 'bot_not_found');
  const convId = chat.store.direct(user, bot.id, bot.name);
  return new Promise<string>((resolve, reject) => {
    let sentAt = 0;
    const timer = setTimeout(() => finish(new Error('The Bot did not answer in time. Its reply will appear in the chat.')), REPLY_TIMEOUT_MS);
    const finish = (e: Error | null, out?: string) => {
      clearTimeout(timer);
      off();
      signal.removeEventListener('abort', onAbort);
      if (e) reject(e);
      else resolve(out!);
    };
    const onAbort = () => finish(new Error('cancelled'));
    const off = ctx.bus.subscribe((ev) => {
      if (ev.userId !== user.id || ev.event !== CHAT_EVENTS.messageDone) return;
      const m = ev.data as Message;
      if (m.conversationId !== convId || m.author !== 'bot' || m.botId !== bot.id || m.createdAt < sentAt) return;
      finish(null, m.status === 'error' ? `The Bot could not answer: ${m.error ?? 'error'}` : m.text);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const sent = chat.runtime.send(user, convId, { text: body, clientId: newId('mcpc') });
      sentAt = sent.createdAt;
    } catch (e) {
      finish(e as Error);
    }
  });
}

function buildServer(ctx: AppContext, chat: Chat, user: User, routines: (user: User) => Routine[]): McpServer {
  const server = new McpServer({ name: 'stellarcortex-advence', version: '1.0.0' }, { instructions: 'Message the owner\'s Bots, list routines and read the Library of StellarCortex Advence.' });
  server.registerTool('list_bots', { description: 'List the Bots you can message.', inputSchema: z.object({}) }, async () => {
    const bots = chat.bots.list(user).map((b) => ({ id: b.id, name: b.name, primary: b.primary, proactive: b.proactive }));
    return { ...text(JSON.stringify(bots, null, 2)), structuredContent: { bots } };
  });
  server.registerTool(
    'message_bot',
    { description: 'Send a message to one Bot in its direct chat and get its reply.', inputSchema: z.object({ bot: z.string().min(1).max(64).describe('Bot name or id'), text: z.string().min(1).max(20_000) }) },
    async ({ bot, text: body }, extra) => {
      try {
        const signal = (extra as { mcpReq?: { signal?: AbortSignal } } | undefined)?.mcpReq?.signal ?? AbortSignal.timeout(REPLY_TIMEOUT_MS + 5000);
        return text(await messageBot(ctx, chat, user, bot, body, signal));
      } catch (e) {
        const msg = e instanceof HttpError && e.code === 'bot_not_found' ? 'No such Bot. Use list_bots.' : (e as Error).message;
        return { ...text(msg), isError: true };
      }
    },
  );
  server.registerTool('list_routines', { description: 'List the routines your Bots run.', inputSchema: z.object({}) }, async () => {
    const list = routines(user);
    return { ...text(list.length ? JSON.stringify(list, null, 2) : 'No routines yet.'), structuredContent: { routines: list } };
  });
  server.registerTool(
    'read_library',
    { description: 'List what the Bots produced (links, pages, images, files), newest first.', inputSchema: z.object({ bot: z.string().max(64).optional(), limit: z.number().int().min(1).max(200).optional() }) },
    async ({ bot, limit }) => {
      const b = bot ? chat.bots.list(user).find((x) => x.id === bot || x.name.toLocaleLowerCase() === bot.toLocaleLowerCase()) : undefined;
      if (bot && !b) return { ...text('No such Bot. Use list_bots.'), isError: true };
      const items = chat.library.list(user, { ...(b ? { botId: b.id } : {}), limit: limit ?? 50 }).map((i) => ({ title: i.title, kind: i.kind, url: i.url, botId: i.botId, createdAt: new Date(i.createdAt).toISOString() }));
      return { ...text(items.length ? JSON.stringify(items, null, 2) : 'The Library is empty.'), structuredContent: { items } };
    },
  );
  return server;
}

/** Registers /mcp. Requests carrying an Origin header (browsers) are refused (DNS rebinding). */
export function registerMcpServer(app: FastifyInstance, ctx: AppContext, chat: Chat, tokens: McpTokens, routines: (user: User) => Routine[] = () => []): () => Promise<void> {
  const handlers = new Map<string, ReturnType<typeof createMcpHandler>>();
  const handlerFor = (user: User) => {
    let h = handlers.get(user.id);
    if (!h) {
      h = createMcpHandler(() => buildServer(ctx, chat, user, routines));
      handlers.set(user.id, h);
    }
    return h;
  };
  const handle = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.origin) return reply.code(403).send({ error: 'origin_not_allowed' });
    const user = tokens.verify(req.headers.authorization);
    if (!user) return reply.code(401).header('www-authenticate', 'Bearer realm="stellarcortex-advence"').send({ error: 'unauthorized' });
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || k === 'host' || k === 'connection' || k === 'content-length' || k === 'authorization') continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }
    const ac = new AbortController();
    reply.raw.on('close', () => ac.abort());
    const url = `https://${req.headers.host ?? 'localhost'}${req.url}`;
    const raw = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const body = req.method === 'POST' ? (raw ? new Uint8Array(raw) : JSON.stringify(req.body ?? null)) : undefined;
    const res = await handlerFor(user).fetch(new Request(url, { method: req.method, headers, body, signal: ac.signal }));
    reply.code(res.status);
    res.headers.forEach((v, k) => {
      if (k !== 'content-length' && k !== 'transfer-encoding') reply.header(k, v);
    });
    reply.header('cache-control', 'no-store');
    if (!res.body) return reply.send();
    return reply.send(Readable.fromWeb(res.body as never));
  };
  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: handle });
  return async () => {
    for (const h of handlers.values()) await h.close?.();
    handlers.clear();
  };
}
