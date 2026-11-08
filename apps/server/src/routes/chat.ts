// P2 REST API: model sources, Bots, conversations, messages, attachments, Library, usage,
// search, activity and notifications. Everything here needs a signed-in session.
import type { FastifyRequest } from 'fastify';
import {
  CHAT_EVENTS, CreateBotReq, CreateGroupReq, CreateModelSourceReq, DraftReq, NotificationsPatch, OpenDirectReq, ReactReq,
  RegisterPushReq, SendMessageReq, UpdateBotReq, UpdateGroupReq, UpdateModelSourceReq, UploadAttachmentReq,
  type AttachmentData, type Notifications, type User,
} from '@advence/protocol';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, parse, router, userOf } from '../http.js';
import type { Chat } from '../chat/index.js';

const Paging = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  parentId: z.string().max(64).optional(),
  botId: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  since: z.coerce.number().int().min(0).optional(),
});

const params = (req: FastifyRequest) => req.params as Record<string, string>;
const query = (req: FastifyRequest) => parse(Paging, req.query ?? {});

export interface BotHooks {
  created(user: User, botId: string): void;
  archived(user: User, botId: string): void;
}

export function registerChatRoutes(app: import('fastify').FastifyInstance, ctx: AppContext, chat: Chat, hooks?: BotHooks): void {
  const route = router(app, ctx);
  const { bots, store, sources, library, usage, activity, push, search, runtime, logins } = chat;

  const botEvent = (user: User, id: string) => {
    const b = bots.get(id);
    ctx.bus.publish(user.id, CHAT_EVENTS.botUpdated, b ?? { id, archived: true });
  };

  // ---- model sources (D-07, FR-BOT-04)
  route('GET', '/v1/sources', 'session', (req) => sources.list(userOf(req).id));
  route('POST', '/v1/sources', 'session', (req) => {
    const user = userOf(req);
    const s = sources.create(user, parse(CreateModelSourceReq, req.body));
    activity.log(user.id, null, 'source.created', { name: s.name, kind: s.kind });
    return s;
  });
  route('PATCH', '/v1/sources/:id', 'session', (req) => sources.update(userOf(req), params(req).id!, parse(UpdateModelSourceReq, req.body)));
  route('DELETE', '/v1/sources/:id', 'session', (req) => {
    const user = userOf(req);
    const r = sources.owned(user, params(req).id!);
    logins.cancel(r.id);
    sources.delete(user, r.id);
    activity.log(user.id, null, 'source.deleted', { name: r.name });
  });
  route('GET', '/v1/sources/:id/models', 'session', async (req) => {
    const user = userOf(req);
    const r = sources.owned(user, params(req).id!);
    const { provider } = sources.provider(user, `src-${r.id}`, r.id);
    try {
      return { models: await provider.listModels(AbortSignal.timeout(15_000)) };
    } catch {
      throw new HttpError(502, 'models_unavailable');
    }
  });
  // ChatGPT subscription: device login through the Codex CLI (owner only, D-07c).
  route('POST', '/v1/sources/:id/login', 'owner', async (req) => {
    const r = sources.owned(userOf(req), params(req).id!);
    if (r.kind !== 'chatgpt-subscription') throw new HttpError(400, 'login_not_supported');
    return logins.start(r.id);
  });
  route('GET', '/v1/sources/:id/login', 'owner', (req) => {
    const r = sources.owned(userOf(req), params(req).id!);
    return logins.get(r.id) ?? { state: 'failed', url: null, code: null, error: 'not_started' };
  });
  route('DELETE', '/v1/sources/:id/login', 'owner', (req) => {
    const r = sources.owned(userOf(req), params(req).id!);
    logins.cancel(r.id);
  });

  // ---- Bots (FR-BOT-01, FR-UI-03)
  route('GET', '/v1/bots', 'session', (req) => bots.list(userOf(req)));
  route('POST', '/v1/bots', 'session', (req) => {
    const user = userOf(req);
    const b = bots.create(user, parse(CreateBotReq, req.body));
    activity.log(user.id, b.id, 'bot.created', { bot: b.name });
    botEvent(user, b.id);
    hooks?.created(user, b.id);
    return b;
  });
  route('GET', '/v1/bots/:id', 'session', (req) => bots.owned(userOf(req), params(req).id!));
  route('PATCH', '/v1/bots/:id', 'session', (req) => {
    const user = userOf(req);
    const b = bots.update(user, params(req).id!, parse(UpdateBotReq, req.body));
    activity.log(user.id, b.id, 'bot.updated', { bot: b.name });
    botEvent(user, b.id);
    return b;
  });
  route('DELETE', '/v1/bots/:id', 'session', (req) => {
    const user = userOf(req);
    const b = bots.owned(user, params(req).id!);
    bots.archive(user, b.id);
    hooks?.archived(user, b.id);
    activity.log(user.id, b.id, 'bot.archived', { bot: b.name });
    botEvent(user, b.id);
  });
  route('GET', '/v1/bots/:id/activity', 'session', (req) => {
    const user = userOf(req);
    const b = bots.owned(user, params(req).id!);
    return activity.list(user, { ...query(req), botId: b.id });
  });

  // ---- conversations (FR-UI-01, FR-BOT-03)
  route('GET', '/v1/conversations', 'session', (req) => store.listConversations(userOf(req)));
  route('POST', '/v1/conversations/direct', 'session', (req) => {
    const user = userOf(req);
    const b = bots.owned(user, parse(OpenDirectReq, req.body).botId);
    return store.getConversation(user, store.direct(user, b.id, b.name));
  });
  route('POST', '/v1/conversations/group', 'session', (req) => {
    const user = userOf(req);
    const p = parse(CreateGroupReq, req.body);
    const ids = [...new Set(p.botIds)];
    for (const id of ids) bots.owned(user, id);
    const c = store.getConversation(user, store.createConv(user.id, 'group', p.title, ids));
    ctx.bus.publish(user.id, CHAT_EVENTS.conversationUpdated, c);
    return c;
  });
  route('GET', '/v1/conversations/:id', 'session', (req) => store.getConversation(userOf(req), params(req).id!));
  route('PATCH', '/v1/conversations/:id', 'session', (req) => {
    const user = userOf(req);
    const id = params(req).id!;
    const c = store.ownedConv(user, id);
    const p = parse(UpdateGroupReq, req.body);
    if (c.kind !== 'group') throw new HttpError(409, 'not_a_group');
    if (p.title) store.setTitle(user, id, p.title);
    if (p.botIds) {
      const ids = [...new Set(p.botIds)];
      for (const b of ids) bots.owned(user, b);
      ctx.db.transaction(() => {
        ctx.db.prepare('DELETE FROM conversation_bots WHERE conversation_id = ?').run(id);
        for (const b of ids) ctx.db.prepare('INSERT INTO conversation_bots(conversation_id, bot_id) VALUES(?,?)').run(id, b);
      })();
    }
    const out = store.getConversation(user, id);
    ctx.bus.publish(user.id, CHAT_EVENTS.conversationUpdated, out);
    return out;
  });
  route('DELETE', '/v1/conversations/:id', 'session', (req) => {
    const user = userOf(req);
    const id = params(req).id!;
    if (store.ownedConv(user, id).kind !== 'group') throw new HttpError(409, 'not_a_group');
    store.archiveConv(user, id);
    search.removeConversation(id);
  });
  route('POST', '/v1/conversations/:id/read', 'session', (req) => store.markRead(userOf(req), params(req).id!));
  route('GET', '/v1/conversations/:id/draft', 'session', (req) => ({ text: store.getDraft(userOf(req), params(req).id!) }));
  route('PUT', '/v1/conversations/:id/draft', 'session', (req) => store.setDraft(userOf(req), params(req).id!, parse(DraftReq, req.body).text));

  // ---- messages (FR-UI-02)
  route('GET', '/v1/conversations/:id/messages', 'session', (req) => {
    const q = query(req);
    return store.messages(userOf(req), params(req).id!, { parentId: q.parentId, before: q.before, limit: q.limit });
  });
  route('POST', '/v1/conversations/:id/messages', 'session', (req) => runtime.send(userOf(req), params(req).id!, parse(SendMessageReq, req.body)));
  route('POST', '/v1/messages/:id/stop', 'session', (req) => runtime.stop(userOf(req), params(req).id!));
  route('POST', '/v1/messages/:id/reactions', 'session', (req) => {
    const user = userOf(req);
    const id = params(req).id!;
    store.toggleReaction(user, id, parse(ReactReq, req.body).emoji);
    const m = store.toMessage(store.msgRow(id)!, user.id);
    ctx.bus.publish(user.id, CHAT_EVENTS.messageUpdated, m);
    return m;
  });

  // ---- attachments (sealed files)
  route('POST', '/v1/attachments', 'session', (req) => {
    const user = userOf(req);
    const p = parse(UploadAttachmentReq, req.body);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(p.dataB64)) throw new HttpError(400, 'invalid_data');
    return store.addAttachment(user.id, p.name, p.mime, Buffer.from(p.dataB64, 'base64'));
  });
  route('GET', '/v1/attachments/:id', 'session', (req): AttachmentData => {
    const a = store.ownedAttachment(userOf(req), params(req).id!);
    return { ...a, dataB64: Buffer.from(store.readAttachment(a.id)).toString('base64') };
  });

  // ---- Library, usage, search, activity (FR-UI-04, FR-BOT-05, FR-UI-01)
  route('GET', '/v1/library', 'session', (req) => {
    const user = userOf(req);
    const q = query(req);
    if (q.botId) bots.owned(user, q.botId);
    return library.list(user, q);
  });
  route('GET', '/v1/usage', 'session', (req) => usage.summary(userOf(req), query(req).since));
  route('GET', '/v1/search', 'session', (req) => {
    const user = userOf(req);
    return search.search(user, query(req).q ?? '', bots.list(user).map((b) => ({ id: b.id, name: b.name })));
  });
  route('GET', '/v1/activity', 'session', (req) => activity.list(userOf(req), query(req)));

  // ---- notifications and push (D-18)
  const notifications = (req: FastifyRequest): Notifications => {
    const user = userOf(req);
    return { pushServer: push.server(), muted: push.muted(user.id), registered: push.registered(req.auth!.deviceId) };
  };
  route('GET', '/v1/notifications', 'session', notifications);
  route('PATCH', '/v1/notifications', 'session', (req) => {
    const user = userOf(req);
    const p = parse(NotificationsPatch, req.body);
    if (p.pushServer !== undefined) {
      if (user.role !== 'owner') throw new HttpError(403, 'owner_only');
      push.setServer(p.pushServer);
    }
    if (p.muted !== undefined) push.setMuted(user.id, p.muted);
    return notifications(req);
  });
  route('PUT', '/v1/push', 'session', (req) => {
    push.register(userOf(req), req.auth!.deviceId, parse(RegisterPushReq, req.body).endpoint);
    return notifications(req);
  });
  route('DELETE', '/v1/push', 'session', (req) => {
    push.unregister(req.auth!.deviceId);
    return notifications(req);
  });

}
