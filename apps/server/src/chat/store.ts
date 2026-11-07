// Conversations, messages, threads, reactions, drafts and attachments (FR-UI-01, FR-UI-02).
// Every piece of content is sealed under the content key with a per-row AAD (NFR-SEC-04).
import fs from 'node:fs';
import path from 'node:path';
import type { Attachment, Conversation, EngineStep, Message, User } from '@advence/protocol';
import { MAX_ATTACHMENT_BYTES } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';
import { newId } from '../ids.js';

interface ConvRow { id: string; user_id: string; kind: 'direct' | 'group'; title: Buffer; created_at: number; updated_at: number }
export interface MsgRow {
  id: string; conversation_id: string; author: 'user' | 'bot' | 'system'; user_id: string | null; bot_id: string | null;
  body: Buffer; parent_id: string | null; status: 'done' | 'streaming' | 'error'; error: string | null; client_id: string | null;
  created_at: number; updated_at: number; steps: Buffer | null;
}
interface Body { text: string; mentions: string[] }

/** One line of plain text for the conversation list: markdown links, emphasis and code marks removed. */
export function previewOf(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~|]+/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export class ChatStore {
  readonly attachmentsDir: string;
  constructor(private ctx: AppContext) {
    this.attachmentsDir = path.join(ctx.config.dataDir, 'attachments');
    fs.mkdirSync(this.attachmentsDir, { recursive: true, mode: 0o700 });
  }

  // ---------- conversations
  private conv(id: string): ConvRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM conversations WHERE id = ? AND archived_at IS NULL').get(id) as ConvRow | undefined;
  }

  ownedConv(user: User, id: string): ConvRow {
    const c = this.conv(id);
    if (!c || c.user_id !== user.id) throw new HttpError(404, 'not_found');
    return c;
  }

  convOwner(id: string): string | undefined {
    return this.conv(id)?.user_id;
  }

  botIds(convId: string): string[] {
    return (this.ctx.db
      .prepare('SELECT cb.bot_id FROM conversation_bots cb JOIN bots b ON b.id = cb.bot_id WHERE cb.conversation_id = ? AND b.archived_at IS NULL ORDER BY b.is_primary DESC, b.created_at')
      .all(convId) as { bot_id: string }[]).map((r) => r.bot_id);
  }

  title(c: ConvRow): string {
    return this.ctx.crypto.openContent(c.title, `conv:${c.id}`);
  }

  kind(convId: string): 'direct' | 'group' | undefined {
    return this.conv(convId)?.kind;
  }

  /** The one direct chat between a user and one of their Bots. */
  direct(user: User, botId: string, botName: string): string {
    const r = this.ctx.db
      .prepare("SELECT c.id FROM conversations c JOIN conversation_bots cb ON cb.conversation_id = c.id WHERE c.user_id = ? AND c.kind = 'direct' AND cb.bot_id = ? AND c.archived_at IS NULL")
      .get(user.id, botId) as { id: string } | undefined;
    if (r) return r.id;
    return this.createConv(user.id, 'direct', botName, [botId]);
  }

  createConv(userId: string, kind: 'direct' | 'group', title: string, botIds: string[]): string {
    const id = newId('conv');
    const now = Date.now();
    this.ctx.db.transaction(() => {
      this.ctx.db.prepare('INSERT INTO conversations(id, user_id, kind, title, created_at, updated_at) VALUES(?,?,?,?,?,?)').run(id, userId, kind, this.ctx.crypto.sealContent(title, `conv:${id}`), now, now);
      for (const b of botIds) this.ctx.db.prepare('INSERT INTO conversation_bots(conversation_id, bot_id) VALUES(?,?)').run(id, b);
    })();
    return id;
  }

  setTitle(user: User, id: string, title: string): void {
    this.ownedConv(user, id);
    this.ctx.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(this.ctx.crypto.sealContent(title, `conv:${id}`), id);
  }

  archiveConv(user: User, id: string): void {
    this.ownedConv(user, id);
    this.ctx.db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(Date.now(), id);
  }

  touch(convId: string, at = Date.now()): void {
    this.ctx.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at, convId);
  }

  toConversation(c: ConvRow, userId: string): Conversation {
    const last = this.ctx.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND parent_id IS NULL ORDER BY created_at DESC LIMIT 1").get(c.id) as MsgRow | undefined;
    const read = (this.ctx.db.prepare('SELECT last_read_at FROM reads WHERE user_id = ? AND conversation_id = ?').get(userId, c.id) as { last_read_at: number } | undefined)?.last_read_at ?? 0;
    const unread = (this.ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND author != 'user' AND status = 'done' AND created_at > ?").get(c.id, read) as { n: number }).n;
    return {
      id: c.id,
      kind: c.kind,
      title: this.title(c),
      botIds: this.botIds(c.id),
      updatedAt: c.updated_at,
      lastPreview: last ? previewOf(this.body(last).text) : '',
      unread,
    };
  }

  listConversations(user: User): Conversation[] {
    const rows = this.ctx.db.prepare('SELECT * FROM conversations WHERE user_id = ? AND archived_at IS NULL ORDER BY updated_at DESC').all(user.id) as ConvRow[];
    // A direct chat whose Bot was archived is hidden with it.
    return rows.filter((c) => c.kind === 'group' || this.botIds(c.id).length > 0).map((c) => this.toConversation(c, user.id));
  }

  getConversation(user: User, id: string): Conversation {
    return this.toConversation(this.ownedConv(user, id), user.id);
  }

  markRead(user: User, convId: string): void {
    this.ownedConv(user, convId);
    this.ctx.db
      .prepare('INSERT INTO reads(user_id, conversation_id, last_read_at) VALUES(?,?,?) ON CONFLICT(user_id, conversation_id) DO UPDATE SET last_read_at = excluded.last_read_at')
      .run(user.id, convId, Date.now());
  }

  // ---------- messages
  body(r: MsgRow): Body {
    return JSON.parse(this.ctx.crypto.openContent(r.body, `msg:${r.id}`)) as Body;
  }

  private seal(id: string, b: Body): Buffer {
    return this.ctx.crypto.sealContent(JSON.stringify(b), `msg:${id}`);
  }

  msgRow(id: string): MsgRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MsgRow | undefined;
  }

  toMessage(r: MsgRow, userId: string): Message {
    const b = this.body(r);
    const reactions = this.ctx.db.prepare('SELECT emoji, COUNT(*) n, SUM(user_id = ?) mine FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY MIN(rowid)').all(userId, r.id) as { emoji: string; n: number; mine: number }[];
    const replyCount = r.parent_id ? 0 : (this.ctx.db.prepare('SELECT COUNT(*) n FROM messages WHERE parent_id = ?').get(r.id) as { n: number }).n;
    return {
      id: r.id,
      conversationId: r.conversation_id,
      author: r.author,
      userId: r.user_id,
      botId: r.bot_id,
      text: b.text,
      parentId: r.parent_id,
      attachments: this.attachmentsOf(r.id),
      mentions: b.mentions,
      reactions: reactions.map((x) => ({ emoji: x.emoji, count: x.n, mine: x.mine > 0 })),
      status: r.status,
      error: r.error,
      replyCount,
      ...(r.steps ? { steps: this.steps(r) } : {}),
      createdAt: r.created_at,
    };
  }

  /** Coding engine activity of a reply (FR-CODE-04), sealed like the body. */
  steps(r: MsgRow): EngineStep[] {
    return r.steps ? (JSON.parse(this.ctx.crypto.openContent(r.steps, `steps:${r.id}`)) as EngineStep[]) : [];
  }

  setSteps(id: string, steps: EngineStep[]): void {
    this.ctx.db.prepare('UPDATE messages SET steps = ?, updated_at = ? WHERE id = ?').run(this.ctx.crypto.sealContent(JSON.stringify(steps), `steps:${id}`), Date.now(), id);
  }

  /** Top-level messages, or the replies of one thread, oldest first. */
  messages(user: User, convId: string, o: { parentId?: string | null; before?: number; limit?: number }): Message[] {
    this.ownedConv(user, convId);
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const rows = (o.parentId
      ? this.ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND parent_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?').all(convId, o.parentId, o.before ?? Number.MAX_SAFE_INTEGER, limit)
      : this.ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND parent_id IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?').all(convId, o.before ?? Number.MAX_SAFE_INTEGER, limit)) as MsgRow[];
    return rows.reverse().map((r) => this.toMessage(r, user.id));
  }

  /** Raw rows for model context: the thread (parent + replies) or the top level, newest last. */
  contextRows(convId: string, parentId: string | null, limit = 40): MsgRow[] {
    const rows = (parentId
      ? this.ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND (id = ? OR parent_id = ?) ORDER BY created_at DESC LIMIT ?').all(convId, parentId, parentId, limit)
      : this.ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND parent_id IS NULL ORDER BY created_at DESC LIMIT ?').all(convId, limit)) as MsgRow[];
    return rows.reverse();
  }

  insertMessage(m: { convId: string; author: 'user' | 'bot' | 'system'; userId?: string | null; botId?: string | null; text: string; mentions?: string[]; parentId?: string | null; status?: 'done' | 'streaming'; clientId?: string | null; attachmentIds?: string[] }): MsgRow {
    const id = newId('msg');
    // Strictly increasing timestamps keep ordering stable within one millisecond.
    const last = (this.ctx.db.prepare('SELECT MAX(created_at) t FROM messages WHERE conversation_id = ?').get(m.convId) as { t: number | null }).t ?? 0;
    const now = Math.max(Date.now(), last + 1);
    this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare('INSERT INTO messages(id, conversation_id, author, user_id, bot_id, body, parent_id, status, client_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, m.convId, m.author, m.userId ?? null, m.botId ?? null, this.seal(id, { text: m.text, mentions: m.mentions ?? [] }), m.parentId ?? null, m.status ?? 'done', m.clientId ?? null, now, now);
      for (const a of m.attachmentIds ?? []) this.ctx.db.prepare('INSERT INTO message_attachments(message_id, attachment_id) VALUES(?,?)').run(id, a);
    })();
    this.touch(m.convId, now);
    return this.msgRow(id)!;
  }

  findByClientId(convId: string, clientId: string): MsgRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND client_id = ?').get(convId, clientId) as MsgRow | undefined;
  }

  finishMessage(id: string, text: string, status: 'done' | 'error', error: string | null = null): MsgRow {
    const r = this.msgRow(id)!;
    const b = this.body(r);
    this.ctx.db.prepare('UPDATE messages SET body = ?, status = ?, error = ?, updated_at = ? WHERE id = ?').run(this.seal(id, { ...b, text }), status, error, Date.now(), id);
    return this.msgRow(id)!;
  }

  /** Replies that were streaming when the server stopped are marked as interrupted (NFR-REL-01). */
  recoverInterrupted(): number {
    return this.ctx.db.prepare("UPDATE messages SET status = 'error', error = 'interrupted' WHERE status = 'streaming'").run().changes;
  }

  ownedMessage(user: User, id: string): MsgRow {
    const r = this.msgRow(id);
    if (!r || this.convOwner(r.conversation_id) !== user.id) throw new HttpError(404, 'not_found');
    return r;
  }

  toggleReaction(user: User, msgId: string, emoji: string): void {
    this.ownedMessage(user, msgId);
    const del = this.ctx.db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(msgId, user.id, emoji);
    if (del.changes === 0) this.ctx.db.prepare('INSERT INTO reactions(message_id, user_id, emoji) VALUES(?,?,?)').run(msgId, user.id, emoji);
  }

  // ---------- drafts (persist across restart, FR-UI-02)
  getDraft(user: User, convId: string): string {
    this.ownedConv(user, convId);
    const r = this.ctx.db.prepare('SELECT body FROM drafts WHERE user_id = ? AND conversation_id = ?').get(user.id, convId) as { body: Buffer } | undefined;
    return r ? this.ctx.crypto.openContent(r.body, `draft:${user.id}:${convId}`) : '';
  }

  setDraft(user: User, convId: string, text: string): void {
    this.ownedConv(user, convId);
    if (!text) {
      this.ctx.db.prepare('DELETE FROM drafts WHERE user_id = ? AND conversation_id = ?').run(user.id, convId);
      return;
    }
    this.ctx.db
      .prepare('INSERT INTO drafts(user_id, conversation_id, body, updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id, conversation_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at')
      .run(user.id, convId, this.ctx.crypto.sealContent(text, `draft:${user.id}:${convId}`), Date.now());
  }

  // ---------- attachments (sealed files)
  private attPath(id: string): string {
    if (!/^att_[A-Za-z0-9_-]+$/.test(id)) throw new HttpError(400, 'invalid_id');
    return path.join(this.attachmentsDir, `${id}.bin`);
  }

  addAttachment(userId: string, name: string, mime: string, data: Uint8Array): Attachment {
    if (data.length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, 'attachment_too_large');
    const id = newId('att');
    fs.writeFileSync(this.attPath(id), this.ctx.crypto.sealBytes(data, `att:${id}`), { mode: 0o600 });
    this.ctx.db.prepare('INSERT INTO attachments(id, user_id, name, mime, size, created_at) VALUES(?,?,?,?,?,?)').run(id, userId, this.ctx.crypto.sealContent(name, `attname:${id}`), mime, data.length, Date.now());
    return { id, name, mime, size: data.length };
  }

  attachmentMeta(id: string): (Attachment & { userId: string }) | undefined {
    const r = this.ctx.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as { id: string; user_id: string; name: Buffer; mime: string; size: number } | undefined;
    if (!r) return undefined;
    return { id: r.id, userId: r.user_id, name: this.ctx.crypto.openContent(r.name, `attname:${r.id}`), mime: r.mime, size: r.size };
  }

  ownedAttachment(user: User, id: string): Attachment {
    const m = this.attachmentMeta(id);
    if (!m || m.userId !== user.id) throw new HttpError(404, 'not_found');
    const { userId: _u, ...a } = m;
    return a;
  }

  readAttachment(id: string): Uint8Array {
    return this.ctx.crypto.openBytes(fs.readFileSync(this.attPath(id)), `att:${id}`);
  }

  attachmentsOf(msgId: string): Attachment[] {
    const ids = this.ctx.db.prepare('SELECT attachment_id FROM message_attachments WHERE message_id = ? ORDER BY rowid').all(msgId) as { attachment_id: string }[];
    return ids.map((r) => {
      const m = this.attachmentMeta(r.attachment_id)!;
      return { id: m.id, name: m.name, mime: m.mime, size: m.size };
    });
  }
}
