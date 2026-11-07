// Curator (FR-LRN-05, FR-LRN-06): weekly while the server is idle, marks skills stale after 30 days
// unused and archives them after 90 (both configurable). It never deletes: archiving moves the
// folder under archive/. Pinned and locked skills are left alone. Every run writes a line to a
// JSONL ledger in the vault with a snapshot (the vault commit and the skill states before the
// run), and a run can be rolled back. LLM consolidation of overlapping skills is off by default.
import type { User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { getMeta, setMeta } from '../db.js';
import { HttpError } from '../http.js';
import { newId } from '../ids.js';
import type { Memory } from './memory.js';
import { skillDir, type SkillInfo, type Skills, type SkillStatus } from './skills.js';
import { similarity, checkSize } from './guard.js';
import { parseSkillMd, renderSkillMd, skillMetaOf } from './skill-format.js';

export const LEDGER = 'curator/ledger.jsonl';
const DAY = 86_400_000;
const WEEK = 7 * DAY;

export interface CuratorAction { skillId: string; name: string; botId: string | null; from: SkillStatus; to: SkillStatus; fromDir: string; toDir: string; reason: 'stale' | 'unused' | 'merged'; into?: string }
export interface CuratorRun { type: 'run'; id: string; at: number; dryRun: boolean; actions: CuratorAction[]; snapshot: { commit: string | null; skills: { id: string; status: SkillStatus }[] } }
interface RollbackLine { type: 'rollback'; runId: string; at: number }
type Line = CuratorRun | RollbackLine;

export interface CuratorSettings { staleDays: number; archiveDays: number; consolidation: boolean; lastRun: number | null }

/** Merges two overlapping skills of one Bot into one body, with that Bot's own model. */
export type Merger = (user: User, botId: string, a: { name: string; body: string }, b: { name: string; body: string }) => Promise<string | null>;

export class Curator {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private ctx: AppContext, private memory: Memory, private skills: Skills, private o: { merge?: Merger; idle?: () => boolean; users?: () => User[]; now?: () => number } = {}) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  settings(): CuratorSettings {
    const n = (k: string, d: number) => {
      const v = Number(getMeta(this.ctx.db, k));
      return Number.isInteger(v) && v > 0 ? v : d;
    };
    const last = Number(getMeta(this.ctx.db, 'curator.lastRun'));
    return { staleDays: n('curator.staleDays', 30), archiveDays: n('curator.archiveDays', 90), consolidation: getMeta(this.ctx.db, 'memory.consolidation') === 'true', lastRun: last > 0 ? last : null };
  }

  setSettings(p: { staleDays?: number; archiveDays?: number; consolidation?: boolean }): CuratorSettings {
    const cur = this.settings();
    const stale = p.staleDays ?? cur.staleDays;
    const archive = p.archiveDays ?? cur.archiveDays;
    if (archive <= stale) throw new HttpError(400, 'archive_before_stale');
    setMeta(this.ctx.db, 'curator.staleDays', String(stale));
    setMeta(this.ctx.db, 'curator.archiveDays', String(archive));
    if (p.consolidation !== undefined) setMeta(this.ctx.db, 'memory.consolidation', String(p.consolidation));
    return this.settings();
  }

  ledger(userId: string): Line[] {
    const text = this.memory.vault.read(userId, LEDGER) ?? '';
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
  }

  /** Runs with their state: rolled back or not. Newest first. */
  runs(userId: string): (CuratorRun & { rolledBack: number | null })[] {
    const lines = this.ledger(userId);
    const back = new Map(lines.filter((l): l is RollbackLine => l.type === 'rollback').map((l) => [l.runId, l.at]));
    return lines.filter((l): l is CuratorRun => l.type === 'run').map((r) => ({ ...r, rolledBack: back.get(r.id) ?? null })).reverse();
  }

  private plan(userId: string): CuratorAction[] {
    const { staleDays, archiveDays } = this.settings();
    const now = this.now();
    const out: CuratorAction[] = [];
    for (const s of this.skills.list(userId)) {
      if (s.pinned || s.locked || s.status === 'archived') continue;
      const idle = now - (s.lastUsed ?? s.createdAt);
      if (idle >= archiveDays * DAY) out.push({ skillId: s.id, name: s.name, botId: s.botId, from: s.status, to: 'archived', fromDir: s.dir, toDir: skillDir(s.botId, s.name, true), reason: 'unused' });
      else if (idle >= staleDays * DAY && s.status === 'active') out.push({ skillId: s.id, name: s.name, botId: s.botId, from: s.status, to: 'stale', fromDir: s.dir, toDir: s.dir, reason: 'stale' });
    }
    return out;
  }

  /** Overlapping skills of one Bot (consolidation, off by default). */
  private async consolidate(user: User, skip: Set<string>): Promise<{ actions: CuratorAction[]; writes: { path: string; content: string }[] }> {
    const actions: CuratorAction[] = [];
    const writes: { path: string; content: string }[] = [];
    if (!this.o.merge) return { actions, writes };
    const mine = this.skills.list(user.id).filter((s) => s.botId && s.status !== 'archived' && !s.pinned && !s.locked && !skip.has(s.id));
    const used = new Set<string>();
    // The older skill keeps its name; the newer one is archived into it.
    mine.sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id));
    for (const [i, a] of mine.entries()) {
      for (const b of mine.slice(i + 1)) {
        if (a.botId !== b.botId || used.has(a.id) || used.has(b.id)) continue;
        const ma = this.skills.files(a).get('SKILL.md') ?? '';
        const mb = this.skills.files(b).get('SKILL.md') ?? '';
        const ba = parseSkillMd(ma).body;
        const bb = parseSkillMd(mb).body;
        if (similarity(ba, bb) < 0.5) continue;
        const merged = await this.o.merge(user, a.botId!, { name: a.name, body: ba }, { name: b.name, body: bb }).catch(() => null);
        if (!merged?.trim()) continue;
        try {
          checkSize(merged, 'skill');
        } catch {
          continue;
        }
        used.add(a.id).add(b.id);
        writes.push({ path: `${a.dir}SKILL.md`, content: renderSkillMd(skillMetaOf(ma), merged) });
        actions.push({ skillId: a.id, name: a.name, botId: a.botId, from: a.status, to: a.status, fromDir: a.dir, toDir: a.dir, reason: 'merged', into: a.name });
        actions.push({ skillId: b.id, name: b.name, botId: b.botId, from: b.status, to: 'archived', fromDir: b.dir, toDir: skillDir(b.botId, b.name, true), reason: 'merged', into: a.name });
      }
    }
    return { actions, writes };
  }

  async run(user: User, o: { dryRun: boolean }): Promise<CuratorRun> {
    if (this.running) throw new HttpError(409, 'curator_busy');
    this.running = true;
    try {
      const actions = this.plan(user.id);
      const head = (await this.memory.vault.history(user.id, 1))[0]?.oid ?? null;
      const run: CuratorRun = { type: 'run', id: newId('cur'), at: this.now(), dryRun: o.dryRun, actions, snapshot: { commit: head, skills: this.skills.list(user.id).map((s) => ({ id: s.id, status: s.status })) } };
      if (o.dryRun) return run;
      const merged = this.settings().consolidation ? await this.consolidate(user, new Set(actions.map((a) => a.skillId))) : { actions: [], writes: [] };
      run.actions.push(...merged.actions);
      const changes: { path: string; content: string | null }[] = [...merged.writes];
      for (const a of run.actions) {
        if (a.fromDir === a.toDir) continue;
        for (const p of this.memory.vault.list(user.id, a.fromDir)) {
          const content = changes.find((c) => c.path === p)?.content ?? this.memory.vault.read(user.id, p);
          changes.push({ path: p, content: null }, { path: `${a.toDir}${p.slice(a.fromDir.length)}`, content });
        }
      }
      changes.push({ path: LEDGER, content: `${this.memory.vault.read(user.id, LEDGER) ?? ''}${JSON.stringify(run)}\n` });
      await this.memory.vault.apply(user.id, dedupe(changes), `Curator run ${run.id}: ${run.actions.length} change(s)`);
      for (const a of run.actions) this.skills.setStatus(a.skillId, a.to);
      this.memory.refresh(user.id);
      return run;
    } finally {
      this.running = false;
    }
  }

  /** Puts back the folders and states a run changed, from its snapshot. */
  async rollback(user: User, runId: string): Promise<void> {
    const run = this.runs(user.id).find((r) => r.id === runId);
    if (!run || run.dryRun) throw new HttpError(404, 'not_found');
    if (run.rolledBack) throw new HttpError(409, 'already_rolled_back');
    const then = run.snapshot.commit ? await this.memory.vault.filesAt(user.id, run.snapshot.commit) : new Map<string, string>();
    const changes: { path: string; content: string | null }[] = [];
    for (const a of run.actions) {
      for (const p of this.memory.vault.list(user.id, a.toDir)) if (!then.has(p)) changes.push({ path: p, content: null });
      for (const [p, c] of then) if (p.startsWith(a.fromDir)) changes.push({ path: p, content: c });
    }
    const line: RollbackLine = { type: 'rollback', runId, at: this.now() };
    changes.push({ path: LEDGER, content: `${this.memory.vault.read(user.id, LEDGER) ?? ''}${JSON.stringify(line)}\n` });
    await this.memory.vault.apply(user.id, dedupe(changes), `Curator rollback of ${runId}`);
    const before = new Map(run.snapshot.skills.map((s) => [s.id, s.status]));
    for (const a of run.actions) this.skills.setStatus(a.skillId, before.get(a.skillId) ?? a.from);
    this.memory.refresh(user.id);
  }

  /** Weekly, and only while no Bot is replying. */
  start(): void {
    const tick = async () => {
      const s = this.settings();
      if (s.lastRun && this.now() - s.lastRun < WEEK) return;
      if (this.o.idle && !this.o.idle()) return;
      setMeta(this.ctx.db, 'curator.lastRun', String(this.now()));
      for (const u of this.o.users?.() ?? []) {
        if (!this.skills.list(u.id).length) continue;
        await this.run(u, { dryRun: false }).catch((e) => this.ctx.log.warn({ err: (e as Error).message }, 'curator run failed'));
      }
    };
    this.timer = setInterval(() => void tick(), 60 * 60_000);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

/** Last write per path wins, so a file moved twice ends where it should. */
function dedupe(changes: { path: string; content: string | null }[]): { path: string; content: string | null }[] {
  const m = new Map<string, string | null>();
  for (const c of changes) {
    if (c.content === null && m.has(c.path) && m.get(c.path) !== null) continue;
    m.set(c.path, c.content);
  }
  return [...m].map(([path, content]) => ({ path, content }));
}

export type { SkillInfo };
