// Library of what Bots produce (FR-UI-04): pages, images, videos, files and links.
// Titles and URLs are sealed (NFR-SEC-04).
import { CHAT_EVENTS, type LibraryItem, type User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { newId } from '../ids.js';

type Kind = LibraryItem['kind'];
interface Row { id: string; user_id: string; bot_id: string | null; kind: Kind; body: Buffer; attachment_id: string | null; message_id: string | null; conversation_id: string | null; created_at: number }

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const VIDEO = /\.(mp4|webm|mov|m4v|mkv)$/i;
const FILE = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|txt|md|json)$/i;

export function kindForUrl(url: string): Kind {
  let p = url;
  try {
    p = new URL(url).pathname;
  } catch {
    /* keep raw */
  }
  if (IMAGE.test(p)) return 'image';
  if (VIDEO.test(p)) return 'video';
  if (FILE.test(p)) return 'file';
  return 'link';
}

export function kindForMime(mime: string): Kind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'text/html') return 'page';
  return 'file';
}

/** Links in a Bot reply: markdown links/images first (with their titles), then bare URLs. */
export function extractLinks(text: string): { title: string; url: string }[] {
  const out = new Map<string, string>();
  const md = /!?\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;
  for (const m of text.matchAll(md)) if (!out.has(m[2]!)) out.set(m[2]!, m[1]!.trim());
  const bare = /(?<![(\w])https?:\/\/[^\s<>()\]"'`]{1,2000}/g;
  for (const m of text.matchAll(bare)) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    if (!out.has(url)) out.set(url, '');
  }
  return [...out].slice(0, 50).map(([url, title]) => ({ url, title: title || url }));
}

export class Library {
  constructor(private ctx: AppContext) {}

  private toApi(r: Row): LibraryItem {
    const b = JSON.parse(this.ctx.crypto.openContent(r.body, `lib:${r.id}`)) as { title: string; url: string | null };
    return { id: r.id, botId: r.bot_id, kind: r.kind, title: b.title, url: b.url, attachmentId: r.attachment_id, messageId: r.message_id, conversationId: r.conversation_id, createdAt: r.created_at };
  }

  add(userId: string, i: { botId: string | null; kind: Kind; title: string; url?: string | null; attachmentId?: string | null; messageId?: string | null; conversationId?: string | null }): LibraryItem {
    const id = newId('lib');
    const body = this.ctx.crypto.sealContent(JSON.stringify({ title: i.title.slice(0, 300), url: i.url ?? null }), `lib:${id}`);
    this.ctx.db
      .prepare('INSERT INTO library(id, user_id, bot_id, kind, body, attachment_id, message_id, conversation_id, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, userId, i.botId, i.kind, body, i.attachmentId ?? null, i.messageId ?? null, i.conversationId ?? null, Date.now());
    const item = this.toApi(this.ctx.db.prepare('SELECT * FROM library WHERE id = ?').get(id) as Row);
    this.ctx.bus.publish(userId, CHAT_EVENTS.libraryAdded, item);
    return item;
  }

  /** Items a Bot reply produced: its links and its attached files. */
  fromReply(userId: string, botId: string, convId: string, msgId: string, text: string, attachments: { id: string; name: string; mime: string }[]): LibraryItem[] {
    const items: LibraryItem[] = [];
    for (const l of extractLinks(text)) items.push(this.add(userId, { botId, kind: kindForUrl(l.url), title: l.title, url: l.url, messageId: msgId, conversationId: convId }));
    for (const a of attachments) items.push(this.add(userId, { botId, kind: kindForMime(a.mime), title: a.name, attachmentId: a.id, messageId: msgId, conversationId: convId }));
    return items;
  }

  list(user: User, o: { botId?: string; before?: number; limit?: number }): LibraryItem[] {
    const limit = Math.min(Math.max(o.limit ?? 100, 1), 500);
    const rows = (o.botId
      ? this.ctx.db.prepare('SELECT * FROM library WHERE user_id = ? AND bot_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?').all(user.id, o.botId, o.before ?? Number.MAX_SAFE_INTEGER, limit)
      : this.ctx.db.prepare('SELECT * FROM library WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?').all(user.id, o.before ?? Number.MAX_SAFE_INTEGER, limit)) as Row[];
    return rows.map((r) => this.toApi(r));
  }

  all(userId: string): LibraryItem[] {
    return (this.ctx.db.prepare('SELECT * FROM library WHERE user_id = ?').all(userId) as Row[]).map((r) => this.toApi(r));
  }
}
