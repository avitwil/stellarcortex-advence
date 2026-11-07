// Global search (FR-UI-01). Message text is sealed at rest, so it is indexed in an in-memory
// FTS5 table rebuilt at start (DL-017); nothing plaintext is written to disk.
import Database from 'better-sqlite3';
import type { SearchResult, User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import type { ChatStore, MsgRow } from './store.js';
import type { Library } from './library.js';

/** Turns free text into a safe FTS5 query: each word quoted, prefix-matched, all required. */
export function ftsQuery(q: string): string {
  const words = q.normalize('NFKC').split(/\s+/).map((w) => w.replace(/"/g, '')).filter((w) => w.length > 0).slice(0, 12);
  return words.map((w) => `"${w}"*`).join(' ');
}

export class SearchIndex {
  private mem = new Database(':memory:');
  constructor(private ctx: AppContext, private store: ChatStore, private library: Library) {
    this.mem.exec("CREATE VIRTUAL TABLE m USING fts5(msg_id UNINDEXED, user_id UNINDEXED, conv_id UNINDEXED, created_at UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')");
  }

  rebuild(): number {
    this.mem.exec('DELETE FROM m');
    const rows = this.ctx.db.prepare("SELECT m.*, c.user_id owner FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.archived_at IS NULL AND m.status = 'done'").iterate() as Iterable<MsgRow & { owner: string }>;
    const ins = this.mem.prepare('INSERT INTO m(msg_id, user_id, conv_id, created_at, text) VALUES(?,?,?,?,?)');
    let n = 0;
    this.mem.transaction(() => {
      for (const r of rows) {
        ins.run(r.id, r.owner, r.conversation_id, r.created_at, this.store.body(r).text);
        n++;
      }
    })();
    return n;
  }

  put(userId: string, r: MsgRow): void {
    this.mem.prepare('DELETE FROM m WHERE msg_id = ?').run(r.id);
    if (r.status !== 'done') return;
    this.mem.prepare('INSERT INTO m(msg_id, user_id, conv_id, created_at, text) VALUES(?,?,?,?,?)').run(r.id, userId, r.conversation_id, r.created_at, this.store.body(r).text);
  }

  removeConversation(convId: string): void {
    this.mem.prepare('DELETE FROM m WHERE conv_id = ?').run(convId);
  }

  search(user: User, q: string, bots: { id: string; name: string }[]): SearchResult {
    const text = q.trim().slice(0, 200);
    const empty: SearchResult = { messages: [], bots: [], groups: [], files: [], routines: [] };
    if (!text) return empty;
    const fq = ftsQuery(text);
    const messages = fq
      ? (this.mem
          .prepare("SELECT msg_id id, conv_id conversationId, CAST(created_at AS INTEGER) createdAt, snippet(m, 4, '', '', '…', 16) snippet FROM m WHERE m MATCH ? AND user_id = ? ORDER BY rank LIMIT 30")
          .all(fq, user.id) as SearchResult['messages'])
      : [];
    const needle = text.toLocaleLowerCase();
    const has = (s: string) => s.toLocaleLowerCase().includes(needle);
    const groups = this.store.listConversations(user).filter((c) => c.kind === 'group' && has(c.title)).map((c) => ({ id: c.id, title: c.title })).slice(0, 20);
    const files = this.library.all(user.id).filter((i) => has(i.title) || (i.url ? has(i.url) : false)).slice(0, 20).map((i) => ({ id: i.id, title: i.title, conversationId: i.conversationId }));
    return {
      messages,
      bots: bots.filter((b) => has(b.name)).slice(0, 20),
      groups,
      files,
      // Routines arrive in P6 (FR-UI-06); the result shape already carries them.
      routines: [],
    };
  }

  close(): void {
    this.mem.close();
  }
}
