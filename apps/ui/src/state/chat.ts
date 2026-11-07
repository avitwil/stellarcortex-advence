// Chat state (FR-UI-01..04): Bots, conversations, messages and streaming replies, kept
// current from the event stream.
import { create } from 'zustand';
import {
  CHAT_EVENTS, type Bot, type Conversation, type LibraryItem, type Message, type ModelSource,
} from '@advence/protocol';
import type { ApiClient } from '../api/client';
import { platform } from '../platform';

interface ChatState {
  client: ApiClient | null;
  bots: Bot[];
  sources: ModelSource[];
  conversations: Conversation[];
  /** top-level messages per conversation, oldest first */
  messages: Record<string, Message[]>;
  /** replies per thread parent */
  threads: Record<string, Message[]>;
  activeConv: string | null;
  muted: boolean;
  libraryTick: number;
  attach(client: ApiClient | null): () => void;
  refresh(): Promise<void>;
  loadSources(): Promise<void>;
  loadMessages(convId: string, more?: boolean): Promise<boolean>;
  loadThread(convId: string, parentId: string): Promise<void>;
  setActive(convId: string | null): void;
  send(convId: string, text: string, opts?: { parentId?: string | null; attachmentIds?: string[] }): Promise<void>;
  openDirect(botId: string): Promise<string>;
  botById(id: string | null | undefined): Bot | undefined;
}

let seq = 0;
const clientId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function upsert(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    const copy = list.slice();
    copy[i] = m;
    return copy;
  }
  return [...list, m].sort((a, b) => a.createdAt - b.createdAt);
}

export const useChat = create<ChatState>((set, get) => ({
  client: null,
  bots: [],
  sources: [],
  conversations: [],
  messages: {},
  threads: {},
  activeConv: null,
  muted: false,
  libraryTick: 0,

  attach(client) {
    set({ client, bots: [], conversations: [], messages: {}, threads: {}, activeConv: null });
    if (!client) return () => undefined;
    void get().refresh();
    const sock = client.openSocket();
    const offState = sock.onState((s) => {
      // After a reconnect, fetch what may have been missed.
      if (s === 'open') void get().refresh();
    });
    const off = sock.onEvent((event, data) => onEvent(event, data));
    return () => {
      off();
      offState();
    };
  },

  async refresh() {
    const c = get().client;
    if (!c) return;
    const [bots, conversations, n] = await Promise.all([
      c.call<Bot[]>('GET', '/v1/bots'),
      c.call<Conversation[]>('GET', '/v1/conversations'),
      c.call<{ muted: boolean }>('GET', '/v1/notifications'),
    ]);
    set({ bots, conversations, muted: n.muted });
    const active = get().activeConv;
    if (active) await get().loadMessages(active);
  },

  async loadSources() {
    const c = get().client;
    if (c) set({ sources: await c.call<ModelSource[]>('GET', '/v1/sources') });
  },

  async loadMessages(convId, more = false) {
    const c = get().client;
    if (!c) return false;
    const have = get().messages[convId] ?? [];
    const before = more && have[0] ? `&before=${have[0].createdAt}` : '';
    const page = await c.call<Message[]>('GET', `/v1/conversations/${convId}/messages?limit=50${before}`);
    set((s) => ({ messages: { ...s.messages, [convId]: more ? [...page, ...have] : page } }));
    return page.length === 50;
  },

  async loadThread(convId, parentId) {
    const c = get().client;
    if (!c) return;
    const page = await c.call<Message[]>('GET', `/v1/conversations/${convId}/messages?parentId=${parentId}&limit=200`);
    set((s) => ({ threads: { ...s.threads, [parentId]: page } }));
  },

  setActive(convId) {
    set({ activeConv: convId });
    const c = get().client;
    if (convId && c) {
      void get().loadMessages(convId);
      void c.call('POST', `/v1/conversations/${convId}/read`, {}).then(() =>
        set((s) => ({ conversations: s.conversations.map((x) => (x.id === convId ? { ...x, unread: 0 } : x)) })),
      );
    }
  },

  async send(convId, text, opts = {}) {
    const c = get().client!;
    const m = await c.call<Message>('POST', `/v1/conversations/${convId}/messages`, {
      text,
      parentId: opts.parentId ?? null,
      attachmentIds: opts.attachmentIds ?? [],
      clientId: clientId(),
    });
    place(m);
  },

  async openDirect(botId) {
    const c = get().client!;
    const conv = await c.call<Conversation>('POST', '/v1/conversations/direct', { botId });
    set((s) => ({ conversations: s.conversations.some((x) => x.id === conv.id) ? s.conversations : [conv, ...s.conversations] }));
    return conv.id;
  },

  botById(id) {
    return id ? get().bots.find((b) => b.id === id) : undefined;
  },
}));

function place(m: Message): void {
  useChat.setState((s) => {
    if (m.parentId) {
      const t = s.threads[m.parentId];
      const parentList = s.messages[m.conversationId];
      return {
        threads: t ? { ...s.threads, [m.parentId]: upsert(t, m) } : s.threads,
        messages: parentList
          ? { ...s.messages, [m.conversationId]: parentList.map((p) => (p.id === m.parentId && !t?.some((x) => x.id === m.id) ? { ...p, replyCount: p.replyCount + 1 } : p)) }
          : s.messages,
      };
    }
    const list = s.messages[m.conversationId];
    return list ? { messages: { ...s.messages, [m.conversationId]: upsert(list, m) } } : {};
  });
}

function appendDelta(id: string, convId: string, text: string): void {
  useChat.setState((s) => {
    const patch = (list: Message[] | undefined) => (list ? list.map((m) => (m.id === id ? { ...m, text: m.text + text } : m)) : list);
    const list = s.messages[convId];
    const inTop = list?.some((m) => m.id === id);
    if (inTop) return { messages: { ...s.messages, [convId]: patch(list)! } };
    const threads = { ...s.threads };
    for (const k of Object.keys(threads)) if (threads[k]!.some((m) => m.id === id)) threads[k] = patch(threads[k])!;
    return { threads };
  });
}

function onEvent(event: string, data: unknown): void {
  const s = useChat.getState();
  switch (event) {
    case CHAT_EVENTS.messageCreated:
    case CHAT_EVENTS.messageUpdated:
      place(data as Message);
      break;
    case CHAT_EVENTS.messageDelta: {
      const d = data as { id: string; conversationId: string; text: string };
      appendDelta(d.id, d.conversationId, d.text);
      break;
    }
    case CHAT_EVENTS.messageDone: {
      const m = data as Message;
      place(m);
      notifyDesktop(m);
      break;
    }
    case CHAT_EVENTS.conversationUpdated: {
      const c = data as Conversation;
      const unread = s.activeConv === c.id && typeof document !== 'undefined' && document.visibilityState === 'visible' ? 0 : c.unread;
      useChat.setState((st) => ({
        conversations: [{ ...c, unread }, ...st.conversations.filter((x) => x.id !== c.id)].sort((a, b) => b.updatedAt - a.updatedAt),
      }));
      if (unread === 0 && c.unread > 0) void s.client?.call('POST', `/v1/conversations/${c.id}/read`, {});
      break;
    }
    case CHAT_EVENTS.botUpdated:
      void s.refresh();
      break;
    case CHAT_EVENTS.libraryAdded:
      useChat.setState((st) => ({ libraryTick: st.libraryTick + 1 }));
      void (data as LibraryItem);
      break;
  }
}

/** Desktop: native notification through the open connection when the app is in the background (D-18). */
function notifyDesktop(m: Message): void {
  const s = useChat.getState();
  if (m.author !== 'bot' || m.status !== 'done' || s.muted) return;
  const bot = s.botById(m.botId);
  if (!bot || bot.notify === 'off') return;
  const p = platform();
  if (p.platform === 'android') return; // Android uses UnifiedPush
  if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus() && s.activeConv === m.conversationId) return;
  p.notify(bot.name, m.text.replace(/\s+/g, ' ').slice(0, 120));
}
