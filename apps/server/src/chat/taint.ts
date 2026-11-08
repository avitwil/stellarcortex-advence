// NFR-SEC-11: memory notes and skills a Bot wrote while outside content was in its context.
// Reading one later taints the reader, so outside content cannot be laundered through memory
// into a Bot that may not act on it. Marks are never removed by Bots.
import type Database from 'better-sqlite3';

export type MarkKind = 'note' | 'skill';

export class TaintMarks {
  constructor(private db: Database.Database) {}

  mark(userId: string, kind: MarkKind, key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO tainted_items(user_id, kind, key, created_at) VALUES(?,?,?,?)').run(userId, kind, key, Date.now());
  }

  has(userId: string, kind: MarkKind, key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM tainted_items WHERE user_id = ? AND kind = ? AND key = ?').get(userId, kind, key);
  }

  all(userId: string, kind: MarkKind): Set<string> {
    return new Set((this.db.prepare('SELECT key FROM tainted_items WHERE user_id = ? AND kind = ?').all(userId, kind) as { key: string }[]).map((r) => r.key));
  }
}
