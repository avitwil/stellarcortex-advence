// Memory retrieval (FR-MEM-03): an in-memory SQLite FTS5 index over note titles, frontmatter
// tags and bodies, rebuilt from the vault (nothing plaintext on disk when the vault is
// encrypted). Ranking is BM25 with titles and tags weighted above bodies.
import Database from 'better-sqlite3';
import { noteName, parseNote, summary } from './notes.js';

const STOP = new Set(('a an and are as at be but by did do does for from had has have how i if in into is it its me my of on or our so ' +
  'that the their them then there these they this to was we were what when where which who why will with you your about after ' +
  'any can could should would just also than too very want wants like likes').split(' '));

export function retrievalQuery(q: string): string {
  const terms = q.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)).slice(0, 16);
  return [...new Set(terms)].map((w) => `"${w}"*`).join(' OR ');
}

export interface Hit { path: string; title: string; type: string; tags: string[]; summary: string }

export class MemoryIndex {
  private db = new Database(':memory:');
  constructor() {
    this.db.exec("CREATE VIRTUAL TABLE n USING fts5(user_id UNINDEXED, path UNINDEXED, type UNINDEXED, title, tags, body, tokenize = 'porter unicode61 remove_diacritics 2')");
  }

  /** Replaces one user's rows with the given files (notes only). */
  load(userId: string, files: Iterable<[string, string]>): void {
    const del = this.db.prepare('DELETE FROM n WHERE user_id = ?');
    const ins = this.db.prepare('INSERT INTO n(user_id, path, type, title, tags, body) VALUES(?,?,?,?,?,?)');
    this.db.transaction(() => {
      del.run(userId);
      for (const [p, text] of files) {
        if (!p.endsWith('.md') || p.endsWith('MEMORY.md')) continue;
        const note = parseNote(text);
        const title = p.endsWith('/SKILL.md') ? String(note.meta.name ?? noteName(p)) : noteName(p);
        ins.run(userId, p, note.meta.type, title.replace(/[-_]/g, ' '), note.meta.tags.join(' '), `${String(note.meta.description ?? '')}\n${note.body}`);
      }
    })();
  }

  search(userId: string, query: string, prefixes: string[], limit = 5): Hit[] {
    const fq = retrievalQuery(query);
    if (!fq) return [];
    const rows = this.db
      .prepare('SELECT path, title, type, tags, body FROM n WHERE n MATCH ? AND user_id = ? ORDER BY bm25(n, 0, 0, 0, 6.0, 3.0, 1.0) LIMIT 200')
      .all(fq, userId) as { path: string; title: string; type: string; tags: string; body: string }[];
    return rows
      .filter((r) => prefixes.some((p) => r.path.startsWith(p)))
      .slice(0, limit)
      .map((r) => ({ path: r.path, title: r.title, type: r.type, tags: r.tags ? r.tags.split(' ') : [], summary: summary(r.body.split('\n').slice(1).join('\n')) }));
  }

  close(): void {
    this.db.close();
  }
}
