// Skills (D-22, FR-LRN-03/04, FR-SKL-03/05): Agent Skills folders in the user's vault. A Bot's
// own skills live in agents/<bot>/skills/<name>/ and only that Bot creates or patches them;
// skills the owner installed live in skills/<name>/ and every Bot of that user may use them, but
// no Bot may change them. Files of a skill only ever run inside the Bot's computer.
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Bot, User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import type { ModelMessage, ToolCall, ToolSpec } from '../models/types.js';
import type { ToolCtx, ToolProvider } from '../chat/runtime.js';
import type { Activity } from '../chat/activity.js';
import type { ComputerManager } from '../computer/manager.js';
import { HttpError } from '../http.js';
import { newId } from '../ids.js';
import { cleanPath } from './vault.js';
import type { Memory } from './memory.js';
import { agentDir } from './memory.js';
import { checkCapture, checkSize, GuardError, SKILL_NAME, similarity } from './guard.js';
import { parseSkillMd, renderSkillMd, skillMetaOf, validateSkill } from './skill-format.js';
import { zipFiles } from './zip.js';

export type SkillStatus = 'active' | 'stale' | 'archived';
export interface SkillSource { kind: 'bot' | 'github' | 'skills.sh' | 'local'; ref: string; repo?: string; path?: string; sha?: string }
interface SealedMeta { name: string; description: string; source: SkillSource }
interface Row { id: string; user_id: string; bot_id: string | null; name_hash: string; meta: Buffer; status: SkillStatus; pinned: number; locked: number; views: number; uses: number; patches: number; last_used: number | null; created_at: number; updated_at: number }

export interface SkillInfo {
  id: string; userId: string; botId: string | null; name: string; description: string; source: SkillSource;
  status: SkillStatus; pinned: boolean; locked: boolean; views: number; uses: number; patches: number;
  lastUsed: number | null; createdAt: number; updatedAt: number; dir: string;
}

/** Sub-folders the Agent Skills spec defines next to SKILL.md. */
const EXTRA_DIRS = /^(scripts|references|assets)\//;
const MAX_FILES = 200;
const MAX_FILE_CHARS = 512 * 1024;

export const skillDir = (botId: string | null, name: string, archived = false) =>
  `${botId ? agentDir(botId) : ''}${archived ? 'archive/' : ''}skills/${name}/`;

const ViewIn = z.object({ name: z.string().min(1).max(64) });
const CreateIn = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  body: z.string().min(1).max(60_000),
  files: z.array(z.object({ path: z.string().min(1).max(200), content: z.string().max(MAX_FILE_CHARS) })).max(20).optional(),
});
const PatchIn = z.object({
  name: z.string().min(1).max(64),
  find: z.string().min(1).max(20_000).optional(),
  replace: z.string().max(20_000).optional(),
  body: z.string().min(1).max(60_000).optional(),
  description: z.string().min(1).max(1024).optional(),
  file: z.object({ path: z.string().min(1).max(200), content: z.string().max(MAX_FILE_CHARS) }).optional(),
});

export const SKILL_TOOLS = ['skill_view', 'skill_run', 'skill_create', 'skill_patch'] as const;

export class Skills implements ToolProvider {
  constructor(private ctx: AppContext, private memory: Memory, private activity: Activity, private computers: ComputerManager | null) {}

  private nameHash(userId: string, name: string): string {
    return createHmac('sha256', this.ctx.crypto.vaultKey).update(`skill\0${userId}\0${name}`).digest('hex').slice(0, 40);
  }

  private info(r: Row): SkillInfo {
    const m = JSON.parse(this.ctx.crypto.openContent(r.meta, `skill:${r.id}`)) as SealedMeta;
    return {
      id: r.id, userId: r.user_id, botId: r.bot_id, name: m.name, description: m.description, source: m.source,
      status: r.status, pinned: !!r.pinned, locked: !!r.locked, views: r.views, uses: r.uses, patches: r.patches,
      lastUsed: r.last_used, createdAt: r.created_at, updatedAt: r.updated_at, dir: skillDir(r.bot_id, m.name, r.status === 'archived'),
    };
  }

  list(userId: string): SkillInfo[] {
    return (this.ctx.db.prepare('SELECT * FROM skills WHERE user_id = ? ORDER BY created_at').all(userId) as Row[]).map((r) => this.info(r));
  }

  get(userId: string, id: string): SkillInfo {
    const r = this.ctx.db.prepare('SELECT * FROM skills WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
    if (!r) throw new HttpError(404, 'not_found');
    return this.info(r);
  }

  /** Skills a Bot can use: its own and the owner-installed ones, not archived. */
  visible(user: User, bot: Bot): SkillInfo[] {
    const rows = this.ctx.db.prepare("SELECT * FROM skills WHERE user_id = ? AND (bot_id = ? OR bot_id IS NULL) AND status != 'archived' ORDER BY bot_id IS NULL, created_at").all(user.id, bot.id) as Row[];
    return rows.map((r) => this.info(r));
  }

  /** Own skill first, then an installed one with that name. */
  find(user: User, bot: Bot, name: string): SkillInfo | null {
    const h = this.nameHash(user.id, name.trim().normalize('NFKC'));
    const r = this.ctx.db.prepare("SELECT * FROM skills WHERE user_id = ? AND name_hash = ? AND (bot_id = ? OR bot_id IS NULL) AND status != 'archived' ORDER BY bot_id IS NULL LIMIT 1").get(user.id, h, bot.id) as Row | undefined;
    return r ? this.info(r) : null;
  }

  byName(userId: string, botId: string | null, name: string): SkillInfo | null {
    const r = this.ctx.db.prepare("SELECT * FROM skills WHERE user_id = ? AND IFNULL(bot_id, '') = ? AND name_hash = ?").get(userId, botId ?? '', this.nameHash(userId, name)) as Row | undefined;
    return r ? this.info(r) : null;
  }

  /** The skill's files, relative to its folder. */
  files(s: Pick<SkillInfo, 'userId' | 'dir'>): Map<string, string> {
    const out = new Map<string, string>();
    for (const p of this.memory.vault.list(s.userId, s.dir)) out.set(p.slice(s.dir.length), this.memory.vault.read(s.userId, p) ?? '');
    return out;
  }

  private bump(id: string, field: 'views' | 'uses' | 'patches'): void {
    const now = Date.now();
    if (field === 'uses') this.ctx.db.prepare("UPDATE skills SET uses = uses + 1, last_used = ?, status = CASE status WHEN 'stale' THEN 'active' ELSE status END WHERE id = ?").run(now, id);
    else if (field === 'views') this.ctx.db.prepare('UPDATE skills SET views = views + 1 WHERE id = ?').run(id);
    else this.ctx.db.prepare('UPDATE skills SET patches = patches + 1, updated_at = ? WHERE id = ?').run(now, id);
  }

  /** Inserts or replaces the DB row of a skill whose files were just written. */
  record(userId: string, botId: string | null, meta: SealedMeta, existing: SkillInfo | null): string {
    const now = Date.now();
    const id = existing?.id ?? newId('skl');
    const sealed = this.ctx.crypto.sealContent(JSON.stringify(meta), `skill:${id}`);
    if (existing) this.ctx.db.prepare('UPDATE skills SET meta = ?, updated_at = ? WHERE id = ?').run(sealed, now, id);
    else this.ctx.db.prepare('INSERT INTO skills(id, user_id, bot_id, name_hash, meta, created_at, updated_at) VALUES(?,?,?,?,?,?,?)').run(id, userId, botId, this.nameHash(userId, meta.name), sealed, now, now);
    return id;
  }

  setStatus(id: string, status: SkillStatus): void {
    this.ctx.db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(status, id);
  }

  restoreRow(r: { id: string; status: SkillStatus; meta?: string }): void {
    this.ctx.db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(r.status, r.id);
  }

  setFlags(userId: string, id: string, f: { pinned?: boolean; locked?: boolean }): SkillInfo {
    const s = this.get(userId, id);
    if (f.pinned !== undefined) this.ctx.db.prepare('UPDATE skills SET pinned = ? WHERE id = ?').run(f.pinned ? 1 : 0, s.id);
    if (f.locked !== undefined) this.ctx.db.prepare('UPDATE skills SET locked = ? WHERE id = ?').run(f.locked ? 1 : 0, s.id);
    return this.get(userId, id);
  }

  /** Zip of the skill folder, named after the skill (FR-SKL-05). */
  export(userId: string, id: string): { name: string; zip: Buffer } {
    const s = this.get(userId, id);
    const files = [...this.files(s)].sort(([a], [b]) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
    return { name: s.name, zip: zipFiles(files.map(([p, c]) => ({ path: `${s.name}/${p}`, data: Buffer.from(c, 'utf8') }))) };
  }

  // ---------------------------------------------------------------- Bot writes (guarded)
  private rejected(user: User, bot: Bot, e: GuardError, name: string): never {
    this.ctx.log.warn({ bot: bot.id, rule: e.rule }, 'skill write rejected');
    this.activity.log(user.id, bot.id, 'memory.rejected', { bot: bot.name, rule: e.rule, path: `skills/${name}` });
    throw e;
  }

  private checkFiles(files: { path: string; content: string }[]): void {
    for (const f of files) {
      const p = cleanPathOrNull(f.path);
      if (!p || !EXTRA_DIRS.test(p)) throw new GuardError('name', 'Skill files go in scripts/, references/ or assets/ and use letters, digits, spaces and - _ . ( ).');
    }
  }

  /** A Bot creates a skill in its own folder (FR-LRN-03). */
  async create(user: User, bot: Bot, w: z.infer<typeof CreateIn>, source = 'chat'): Promise<SkillInfo> {
    const name = w.name.trim();
    try {
      if (!SKILL_NAME.test(name)) throw new GuardError('name', 'Skill names use lowercase letters, digits and single hyphens, up to 64 characters (for example "weekly-report").');
      const body = parseBodyOnly(w.body);
      checkSize(body, 'skill');
      const files = w.files ?? [];
      this.checkFiles(files);
      if (files.length > MAX_FILES) throw new GuardError('size', 'Too many files in one skill.');
      checkCapture([name, w.description, body, ...files.map((f) => f.content)].join('\n'), { ownerEmail: user.email, scope: 'skill' });
      const archived = this.byName(user.id, bot.id, name);
      if (archived) throw new GuardError('duplicate', archived.status === 'archived' ? `A skill named "${name}" is in your archive. Pick another name.` : `A skill named "${name}" already exists. Patch it with skill_patch instead.`);
      for (const s of this.visible(user, bot)) {
        if (s.name === name) throw new GuardError('duplicate', `A skill named "${name}" already exists. Patch it with skill_patch instead.`);
        const other = this.files(s).get('SKILL.md');
        if (other && body.length > 40 && similarity(body, parseSkillMd(other).body) >= 0.85) throw new GuardError('duplicate', `This repeats the skill "${s.name}". Patch that one instead.`);
      }
      const md = renderSkillMd({ name, description: w.description.trim() }, body);
      const errors = validateSkill(md, name);
      if (errors.length) throw new GuardError('format', `Not a valid Agent Skill: ${errors.join('; ')}`);
      const dir = skillDir(bot.id, name);
      await this.memory.vault.apply(user.id, [{ path: `${dir}SKILL.md`, content: md }, ...files.map((f) => ({ path: `${dir}${cleanPath(f.path)}`, content: f.content }))], `${bot.name}: add skill ${name}`);
      const id = this.record(user.id, bot.id, { name, description: w.description.trim(), source: { kind: 'bot', ref: `${source}` } }, null);
      this.memory.refresh(user.id);
      this.activity.log(user.id, bot.id, 'skill.create', { bot: bot.name, name });
      return this.get(user.id, id);
    } catch (e) {
      if (e instanceof GuardError) this.rejected(user, bot, e, name);
      throw e;
    }
  }

  /** A Bot patches one of its own skills; installed and locked skills are not its to change. */
  async patch(user: User, bot: Bot, w: z.infer<typeof PatchIn>): Promise<SkillInfo> {
    const name = w.name.trim();
    try {
      const s = this.find(user, bot, name);
      if (!s) throw new GuardError('name', `No skill named "${name}". Use skill_create for a new one.`);
      if (s.botId !== bot.id) throw new GuardError('ownership', `"${name}" was installed by the owner; Bots cannot change it.`);
      if (s.locked) throw new GuardError('ownership', `"${name}" is locked by the owner.`);
      const files = this.files(s);
      const meta = skillMetaOf(files.get('SKILL.md') ?? '');
      let body = parseSkillMd(files.get('SKILL.md') ?? '').body;
      if (w.body) body = parseBodyOnly(w.body);
      if (w.find !== undefined) {
        if (!body.includes(w.find)) throw new GuardError('format', 'The text to replace was not found in the skill.');
        body = body.replace(w.find, w.replace ?? '');
      }
      if (w.description) meta.description = w.description.trim();
      const changes: { path: string; content: string }[] = [];
      if (w.file) {
        this.checkFiles([w.file]);
        changes.push({ path: `${s.dir}${cleanPath(w.file.path)}`, content: w.file.content });
      }
      checkSize(body, 'skill');
      checkCapture([meta.description, body, w.file?.content ?? ''].join('\n'), { ownerEmail: user.email, scope: 'skill' });
      const md = renderSkillMd(meta, body);
      const errors = validateSkill(md, name);
      if (errors.length) throw new GuardError('format', `Not a valid Agent Skill: ${errors.join('; ')}`);
      changes.push({ path: `${s.dir}SKILL.md`, content: md });
      await this.memory.vault.apply(user.id, changes, `${bot.name}: patch skill ${name}`);
      this.record(user.id, bot.id, { name, description: meta.description, source: s.source }, s);
      this.bump(s.id, 'patches');
      this.memory.refresh(user.id);
      this.activity.log(user.id, bot.id, 'skill.patch', { bot: bot.name, name });
      return this.get(user.id, s.id);
    } catch (e) {
      if (e instanceof GuardError) this.rejected(user, bot, e, name);
      throw e;
    }
  }

  view(user: User, bot: Bot, name: string): { info: SkillInfo; text: string } {
    const s = this.find(user, bot, name);
    if (!s) throw new HttpError(404, 'not_found');
    const files = this.files(s);
    this.bump(s.id, 'views');
    const others = [...files.keys()].filter((p) => p !== 'SKILL.md');
    const text = `${files.get('SKILL.md') ?? ''}${others.length ? `\n\nFiles: ${others.join(', ')}` : ''}`;
    return { info: s, text };
  }

  /**
   * Uses a skill: its files are copied into the Bot's computer at ~/skills/<name>/, where its
   * scripts may run (FR-SKL-03); nothing of a skill ever runs on the server.
   */
  async use(c: ToolCtx, name: string): Promise<string> {
    const s = this.find(c.user, c.bot, name);
    if (!s) throw new HttpError(404, 'not_found');
    const files = this.files(s);
    const extra = [...files.keys()].filter((p) => p !== 'SKILL.md');
    let where = '';
    if (extra.length) {
      const m = this.computers;
      if (!m || !(await m.runtimeInfo(true)).available) throw new HttpError(503, 'computer_unavailable');
      await m.ensure({ id: c.bot.id, userId: c.user.id });
      const run = m.exec(c.bot.id, ['sh', '-s'], { stdin: materializeScript(s.name, files), signal: c.signal });
      for await (const _ of run.lines) void _;
      const r = await run.done;
      if (r.code !== 0) throw new HttpError(500, 'skill_copy_failed');
      where = `\n\nThe skill's files are in ~/skills/${s.name}/ in your computer (${extra.join(', ')}). Run its scripts there with the code tool.`;
    }
    this.bump(s.id, 'uses');
    this.activity.log(c.user.id, c.bot.id, 'skill.use', { bot: c.bot.name, name: s.name });
    return `${parseSkillMd(files.get('SKILL.md') ?? '---\n---\n').body.trim()}${where}`;
  }

  // ---------------------------------------------------------------- tools for Bots
  specs(): ToolSpec[] {
    return [
      { name: 'skill_view', description: 'Read a skill (its SKILL.md and file list) before following it.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
      { name: 'skill_run', description: 'Use a skill now: returns its instructions and copies its files into your computer at ~/skills/<name>/. Follow the instructions step by step.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } },
      { name: 'skill_create', description: 'Save a reusable procedure as a new skill (Agent Skills format) when the user teaches you a process or asks you to learn it. The body is Markdown with numbered steps. Optional files go in scripts/, references/ or assets/.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'lowercase-with-hyphens' }, description: { type: 'string', description: 'What it does and when to use it' }, body: { type: 'string' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } }, required: ['name', 'description', 'body'], additionalProperties: false } },
      { name: 'skill_patch', description: 'Fix or improve one of your own skills: replace text ("find" and "replace"), the whole body, the description, or one file.', parameters: { type: 'object', properties: { name: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, body: { type: 'string' }, description: { type: 'string' }, file: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } }, required: ['name'], additionalProperties: false } },
    ];
  }

  handles(name: string): boolean {
    return (SKILL_TOOLS as readonly string[]).includes(name);
  }

  system(user: User, bot: Bot): string | null {
    const list = this.visible(user, bot).slice(0, 60);
    if (!list.length) return 'You have no skills yet. When the user teaches you a process, save it with skill_create.';
    return `Your skills (open one with skill_view or use it with skill_run; improve your own with skill_patch):\n${list.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n')}`;
  }

  async run(c: ToolCtx, call: ToolCall): Promise<ModelMessage> {
    const ok = (content: string): ModelMessage => ({ role: 'tool', toolCallId: call.id, content });
    const fail = (content: string): ModelMessage => ({ role: 'tool', toolCallId: call.id, content, isError: true });
    try {
      switch (call.name) {
        case 'skill_view': {
          const p = ViewIn.safeParse(call.input);
          if (!p.success) return fail('Give "name".');
          return ok(this.view(c.user, c.bot, p.data.name).text.slice(0, 60_000));
        }
        case 'skill_run': {
          const p = ViewIn.safeParse(call.input);
          if (!p.success) return fail('Give "name".');
          return ok(await this.use(c, p.data.name));
        }
        case 'skill_create': {
          const p = CreateIn.safeParse(call.input);
          if (!p.success) return fail(`Invalid input: ${p.error.issues[0]?.message ?? ''}`);
          const s = await this.create(c.user, c.bot, p.data, c.convId ? `chat:${c.convId}` : 'learn');
          return ok(`Saved the skill "${s.name}".`);
        }
        case 'skill_patch': {
          const p = PatchIn.safeParse(call.input);
          if (!p.success) return fail(`Invalid input: ${p.error.issues[0]?.message ?? ''}`);
          if (!p.data.find && !p.data.body && !p.data.description && !p.data.file) return fail('Give "find" and "replace", "body", "description" or "file".');
          const s = await this.patch(c.user, c.bot, p.data);
          return ok(`Patched the skill "${s.name}".`);
        }
      }
      return fail(`Unknown tool ${call.name}.`);
    } catch (e) {
      if (e instanceof GuardError) return fail(e.message);
      if (e instanceof HttpError && e.code === 'not_found') return fail('No such skill. Your skills are listed in your instructions.');
      if (e instanceof HttpError && e.code === 'computer_unavailable') return fail('This skill has files that run in your computer, which is not available right now.');
      if (e instanceof HttpError && e.code === 'invalid_path') return fail('That file name has characters skills cannot use.');
      throw e;
    }
  }
}

function cleanPathOrNull(p: string): string | null {
  try {
    return cleanPath(p);
  } catch {
    return null;
  }
}

/** A Bot may send a body with or without frontmatter; only the body is kept. */
function parseBodyOnly(text: string): string {
  if (/^---\r?\n/.test(text)) {
    try {
      return parseSkillMd(text).body.trim();
    } catch {
      return text.trim();
    }
  }
  return text.trim();
}

/** Shell script (run with `sh -s` in the Bot's computer) that writes the skill's files. */
export function materializeScript(name: string, files: Map<string, string>): string {
  if (!/^[\p{L}\p{N}-]{1,64}$/u.test(name)) throw new HttpError(400, 'invalid_name');
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const lines = ['set -e', `d="$HOME/skills/"${q(name)}`, 'rm -rf "$d.new"', 'mkdir -p "$d.new"'];
  for (const [p, content] of files) {
    const rel = cleanPath(p);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (dir) lines.push(`mkdir -p "$d.new/"${q(dir)}`);
    lines.push(`base64 -d > "$d.new/"${q(rel)} <<'ADVENCE_SKILL_EOF'`, ...(Buffer.from(content, 'utf8').toString('base64').match(/.{1,76}/g) ?? []), 'ADVENCE_SKILL_EOF');
    if (rel.startsWith('scripts/') || content.startsWith('#!')) lines.push(`chmod 755 "$d.new/"${q(rel)}`);
  }
  lines.push('rm -rf "$d"', 'mv "$d.new" "$d"');
  return `${lines.join('\n')}\n`;
}
