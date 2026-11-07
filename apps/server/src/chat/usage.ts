// Token and cost usage per Bot per source (FR-BOT-05). Cost is recorded only when the provider
// reports it; it is never estimated.
import type { ModelSourceKind, UsageRow, User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import type { Usage as TurnUsage } from '../models/types.js';

export class UsageLog {
  constructor(private ctx: AppContext) {}

  record(userId: string, botId: string, sourceId: string, sourceKind: ModelSourceKind, model: string, u: TurnUsage): void {
    this.ctx.db
      .prepare('INSERT INTO usage(user_id, bot_id, source_id, source_kind, model, input_tokens, output_tokens, cost_usd, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(userId, botId, sourceId, sourceKind, model, u.inputTokens, u.outputTokens, u.costUsd, Date.now());
  }

  summary(user: User, since = 0): UsageRow[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT bot_id, source_kind, source_id, model, SUM(input_tokens) i, SUM(output_tokens) o,
                SUM(cost_usd) c, COUNT(*) turns
           FROM usage WHERE user_id = ? AND created_at >= ?
          GROUP BY bot_id, source_id, source_kind, model ORDER BY bot_id, source_id, model`,
      )
      .all(user.id, since) as { bot_id: string; source_kind: ModelSourceKind; source_id: string; model: string; i: number; o: number; c: number | null; turns: number }[];
    return rows.map((r) => ({ botId: r.bot_id, sourceKind: r.source_kind, sourceId: r.source_id, model: r.model, inputTokens: r.i, outputTokens: r.o, costUsd: r.c, turns: r.turns }));
  }
}
