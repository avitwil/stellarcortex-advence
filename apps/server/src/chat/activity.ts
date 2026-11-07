// Activity log base (P2): what Bots did, per user. Summaries are sealed (NFR-SEC-04).
import type { ActivityEntry, User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { newId } from '../ids.js';

interface Row { id: string; user_id: string; bot_id: string | null; kind: string; summary: Buffer; created_at: number }

export class Activity {
  constructor(private ctx: AppContext) {}

  log(userId: string, botId: string | null, kind: string, summary: string): void {
    const id = newId('act');
    this.ctx.db
      .prepare('INSERT INTO activity(id, user_id, bot_id, kind, summary, created_at) VALUES(?,?,?,?,?,?)')
      .run(id, userId, botId, kind, this.ctx.crypto.sealContent(summary.slice(0, 1000), `act:${id}`), Date.now());
  }

  list(user: User, o: { botId?: string; before?: number; limit?: number }): ActivityEntry[] {
    const limit = Math.min(Math.max(o.limit ?? 100, 1), 500);
    const rows = (o.botId
      ? this.ctx.db.prepare('SELECT * FROM activity WHERE user_id = ? AND bot_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(user.id, o.botId, o.before ?? Number.MAX_SAFE_INTEGER, limit)
      : this.ctx.db.prepare('SELECT * FROM activity WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(user.id, o.before ?? Number.MAX_SAFE_INTEGER, limit)) as Row[];
    return rows.map((r) => ({ id: r.id, at: r.created_at, botId: r.bot_id, kind: r.kind, summary: this.ctx.crypto.openContent(r.summary, `act:${r.id}`) }));
  }
}
