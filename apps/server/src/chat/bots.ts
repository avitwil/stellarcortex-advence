// Bots per user (FR-BOT-01, FR-BOT-02, FR-UI-03). Instructions are sealed (NFR-SEC-04).
import type { Bot, Engine, User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';
import { newId } from '../ids.js';

interface BotRow {
  id: string; user_id: string; name: string; avatar: string; instructions: Buffer; source_id: string | null; model: string;
  engine: Engine; tools: string; is_primary: number; proactive: number; host_control: number; notify: 'all' | 'off';
  created_at: number; archived_at: number | null;
}

export const PRIMARY_BOT_NAME = 'Chief of Staff';
/** Every Bot has its own computer (FR-PC-01), so new Bots can code and use it by default. */
export const DEFAULT_TOOLS = ['code', 'computer'];
export const PRIMARY_INSTRUCTIONS =
  'You are the user\'s chief of staff. Answer directly when you can. When another Bot is better suited, hand the task to it with the delegate tool, then summarize its result for the user.';

export class Bots {
  constructor(private ctx: AppContext) {}

  private toApi(r: BotRow): Bot {
    return {
      id: r.id,
      name: r.name,
      avatar: r.avatar,
      instructions: this.ctx.crypto.openContent(r.instructions, `bot:${r.id}`),
      sourceId: r.source_id,
      model: r.model,
      engine: r.engine,
      tools: JSON.parse(r.tools) as string[],
      primary: !!r.is_primary,
      proactive: !!r.proactive,
      hostControl: !!r.host_control,
      notify: r.notify,
      createdAt: r.created_at,
    };
  }

  row(id: string): BotRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM bots WHERE id = ? AND archived_at IS NULL').get(id) as BotRow | undefined;
  }

  get(id: string): Bot | undefined {
    const r = this.row(id);
    return r ? this.toApi(r) : undefined;
  }

  ownerOf(botId: string): string | undefined {
    return this.row(botId)?.user_id;
  }

  /** The Bot, if it belongs to the user; 404 otherwise. */
  owned(user: User, id: string): Bot {
    const r = this.row(id);
    if (!r || r.user_id !== user.id) throw new HttpError(404, 'not_found');
    return this.toApi(r);
  }

  list(user: User): Bot[] {
    this.ensurePrimary(user);
    return (this.ctx.db.prepare('SELECT * FROM bots WHERE user_id = ? AND archived_at IS NULL ORDER BY is_primary DESC, created_at').all(user.id) as BotRow[]).map((r) => this.toApi(r));
  }

  /** Every user has one primary Bot (FR-BOT-02); it is created on first use. */
  ensurePrimary(user: User): void {
    const has = this.ctx.db.prepare('SELECT 1 FROM bots WHERE user_id = ? AND is_primary = 1 AND archived_at IS NULL').get(user.id);
    if (has) return;
    const id = newId('bot');
    this.ctx.db
      .prepare("INSERT INTO bots(id, user_id, name, avatar, instructions, engine, tools, is_primary, created_at) VALUES(?,?,?,?,?,?,?,1,?)")
      .run(id, user.id, PRIMARY_BOT_NAME, '★', this.ctx.crypto.sealContent(PRIMARY_INSTRUCTIONS, `bot:${id}`), 'claude-agent-sdk', JSON.stringify(['delegate', ...DEFAULT_TOOLS]), Date.now());
  }

  private checkSource(user: User, sourceId: string | null | undefined): void {
    if (!sourceId) return;
    const r = this.ctx.db.prepare('SELECT user_id FROM model_sources WHERE id = ?').get(sourceId) as { user_id: string } | undefined;
    if (!r || r.user_id !== user.id) throw new HttpError(400, 'unknown_model_source');
  }

  create(user: User, b: { name: string; avatar?: string; instructions?: string; sourceId?: string | null; model?: string; engine?: Engine; tools?: string[] }): Bot {
    this.checkSource(user, b.sourceId);
    this.ensurePrimary(user);
    const id = newId('bot');
    this.ctx.db
      .prepare('INSERT INTO bots(id, user_id, name, avatar, instructions, source_id, model, engine, tools, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, user.id, b.name, b.avatar ?? b.name.slice(0, 1).toUpperCase(), this.ctx.crypto.sealContent(b.instructions ?? '', `bot:${id}`), b.sourceId ?? null, b.model ?? '', b.engine ?? 'claude-agent-sdk', JSON.stringify(b.tools ?? DEFAULT_TOOLS), Date.now());
    return this.get(id)!;
  }

  update(user: User, id: string, b: Partial<{ name: string; avatar: string; instructions: string; sourceId: string | null; model: string; engine: Engine; tools: string[]; proactive: boolean; hostControl: boolean; notify: 'all' | 'off' }>): Bot {
    this.owned(user, id);
    if (b.sourceId !== undefined) this.checkSource(user, b.sourceId);
    // Host control drives the server's own desktop: only the server owner may turn it on (D-12).
    if (b.hostControl && user.role !== 'owner') throw new HttpError(403, 'owner_only');
    const set: string[] = [];
    const vals: unknown[] = [];
    const put = (col: string, v: unknown) => {
      set.push(`${col} = ?`);
      vals.push(v);
    };
    if (b.name !== undefined) put('name', b.name);
    if (b.avatar !== undefined) put('avatar', b.avatar);
    if (b.instructions !== undefined) put('instructions', this.ctx.crypto.sealContent(b.instructions, `bot:${id}`));
    if (b.sourceId !== undefined) put('source_id', b.sourceId);
    if (b.model !== undefined) put('model', b.model);
    if (b.engine !== undefined) put('engine', b.engine);
    if (b.tools !== undefined) put('tools', JSON.stringify(b.tools));
    if (b.proactive !== undefined) put('proactive', b.proactive ? 1 : 0);
    if (b.hostControl !== undefined) put('host_control', b.hostControl ? 1 : 0);
    if (b.notify !== undefined) put('notify', b.notify);
    if (set.length) this.ctx.db.prepare(`UPDATE bots SET ${set.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.get(id)!;
  }

  /** Deleting archives the Bot; its chats and data are kept, never destroyed (FR-BOT-01). */
  archive(user: User, id: string): void {
    const b = this.owned(user, id);
    if (b.primary) throw new HttpError(409, 'cannot_delete_primary');
    this.ctx.db.prepare('UPDATE bots SET archived_at = ? WHERE id = ?').run(Date.now(), id);
  }
}
