// Long-term memory for Bots (D-20, FR-MEM-01..05) with the write guard (FR-LRN-02).
// Folders per user vault: agents/<bot>/ is private to that Bot and only it writes there;
// shared/ is read by all the user's Bots and only appended to; user/ holds facts about the
// owner and is only appended to. Every Bot write goes through the guard and is one git commit.
import { z } from 'zod';
import type { Bot, User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import type { ModelMessage, ToolCall, ToolSpec } from '../models/types.js';
import type { ToolCtx, ToolProvider, ToolTraits } from '../chat/runtime.js';
import type { Activity } from '../chat/activity.js';
import { Vault } from './vault.js';
import { MemoryIndex, type Hit } from './search.js';
import { NOTE_TYPES, noteName, parseNote, renderIndex, renderNote, today, type Note } from './notes.js';
import { checkCapture, checkDuplicate, checkNoteName, checkSize, GuardError } from './guard.js';

export const agentDir = (botId: string) => `agents/${botId}/`;

const SearchIn = z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(20).optional() });
const ReadIn = z.object({ path: z.string().min(1).max(240) });
const WriteIn = z.object({
  name: z.string().min(1).max(80),
  content: z.string().min(1).max(40_000),
  type: z.enum(NOTE_TYPES).optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
});
const AppendIn = z.object({ folder: z.enum(['shared', 'user']), name: z.string().min(1).max(80), text: z.string().min(1).max(4000) });

export const MEMORY_TOOLS = ['memory_search', 'memory_read', 'memory_write', 'memory_append'] as const;

export class Memory implements ToolProvider {
  readonly vault: Vault;
  readonly index = new MemoryIndex();
  private loaded = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(private ctx: AppContext, private activity: Activity) {
    this.vault = new Vault(ctx);
  }

  /** Re-reads a user's vault into the search index (plain vaults may change outside). */
  refresh(userId: string): void {
    this.index.load(userId, this.vault.list(userId).map((p) => [p, this.vault.read(userId, p) ?? ''] as [string, string]));
    this.loaded.add(userId);
  }

  private ensure(userId: string): void {
    if (!this.loaded.has(userId) || this.vault.mode() === 'plain') this.refresh(userId);
  }

  /** Folders a Bot may read: its own, shared/ and user/. */
  readable(bot: Bot): string[] {
    return [agentDir(bot.id), 'shared/', 'user/'];
  }

  search(user: User, bot: Bot, query: string, limit = 5): Hit[] {
    this.ensure(user.id);
    return this.index.search(user.id, query, this.readable(bot), limit);
  }

  read(user: User, bot: Bot, path: string): string | null {
    const p = path.endsWith('.md') || path.includes('.') ? path : `${path}.md`;
    if (!this.readable(bot).some((r) => p.startsWith(r))) return null;
    return this.vault.read(user.id, p);
  }

  /** Note writes of one user run one at a time, so each sees the last one's index. */
  private locked<T>(userId: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    const next = prev.then(f, f);
    this.locks.set(userId, next.catch(() => undefined));
    return next;
  }

  private rejected(user: User, bot: Bot, e: GuardError, path: string): never {
    this.ctx.log.warn({ bot: bot.id, rule: e.rule }, 'memory write rejected');
    this.activity.log(user.id, bot.id, 'memory.rejected', { bot: bot.name, rule: e.rule, path });
    throw e;
  }

  /** Creates or updates a note in the Bot's own folder, then refreshes its MEMORY.md. */
  async writeNote(user: User, bot: Bot, w: { name: string; content: string; type?: string; tags?: string[] }, source: string): Promise<string> {
    return this.locked(user.id, () => this.writeNoteNow(user, bot, w, source));
  }

  private async writeNoteNow(user: User, bot: Bot, w: { name: string; content: string; type?: string; tags?: string[] }, source: string): Promise<string> {
    const name = w.name.replace(/\.md$/i, '').trim();
    const path = `${agentDir(bot.id)}${name}.md`;
    try {
      checkNoteName(name);
      const incoming = parseNote(w.content);
      const body = incoming.body.trim() || w.content.trim();
      checkSize(body, 'note');
      checkCapture(`${name}\n${body}\n${(w.tags ?? []).join(' ')}`, { ownerEmail: user.email, scope: 'agent' });
      const mine = this.notesIn(user.id, agentDir(bot.id));
      checkDuplicate(name, body, mine.map((n) => ({ name: noteName(n.path), body: n.note.body })));
      const old = this.vault.read(user.id, path);
      const prev = old ? parseNote(old) : null;
      const note: Note = {
        meta: {
          type: w.type ?? (incoming.meta.type !== 'fact' ? incoming.meta.type : prev?.meta.type ?? 'fact'),
          tags: w.tags ?? (incoming.meta.tags.length ? incoming.meta.tags : prev?.meta.tags ?? []),
          created: prev?.meta.created || today(),
          updated: today(),
          source,
        },
        body,
      };
      const notes = [...mine.filter((n) => n.path !== path), { path, note }];
      await this.vault.apply(user.id, [
        { path, content: renderNote(note) },
        { path: `${agentDir(bot.id)}MEMORY.md`, content: renderIndex(bot.name, notes) },
      ], `${bot.name}: ${old ? 'update' : 'add'} ${name}`);
      this.refresh(user.id);
      this.activity.log(user.id, bot.id, 'memory.write', { bot: bot.name, name });
      return path;
    } catch (e) {
      if (e instanceof GuardError) this.rejected(user, bot, e, path);
      throw e;
    }
  }

  /** Appends a dated line to a note in shared/ or user/ (append-only, single writer). */
  async append(user: User, bot: Bot, folder: 'shared' | 'user', name: string, text: string): Promise<string> {
    return this.locked(user.id, () => this.appendNow(user, bot, folder, name, text));
  }

  private async appendNow(user: User, bot: Bot, folder: 'shared' | 'user', name: string, text: string): Promise<string> {
    const clean = name.replace(/\.md$/i, '').trim();
    const path = `${folder}/${clean}.md`;
    try {
      checkNoteName(clean);
      checkCapture(`${clean}\n${text}`, { ownerEmail: user.email, scope: folder });
      const line = text.replace(/\s+/g, ' ').trim();
      const old = this.vault.read(user.id, path);
      const note: Note = old ? parseNote(old) : { meta: { type: folder === 'user' ? 'fact' : 'log', tags: [], created: today(), updated: today(), source: `bot:${bot.id}` }, body: `# ${clean}\n` };
      if (note.body.includes(line)) return path;
      note.meta.updated = today();
      note.body = `${note.body.trimEnd()}\n- ${today()} (${bot.name}): ${line}`;
      checkSize(note.body, 'note');
      await this.vault.apply(user.id, [{ path, content: renderNote(note) }], `${bot.name}: append to ${folder}/${clean}`);
      this.refresh(user.id);
      this.activity.log(user.id, bot.id, 'memory.write', { bot: bot.name, name: `${folder}/${clean}` });
      return path;
    } catch (e) {
      if (e instanceof GuardError) this.rejected(user, bot, e, path);
      throw e;
    }
  }

  notesIn(userId: string, prefix: string): { path: string; note: Note }[] {
    return this.vault
      .list(userId, prefix)
      .filter((p) => p.endsWith('.md') && !p.endsWith('MEMORY.md') && !p.includes('/skills/') && !p.includes('/archive/'))
      .map((p) => ({ path: p, note: parseNote(this.vault.read(userId, p) ?? '') }));
  }

  // ---------------------------------------------------------------- tools for Bots
  specs(): ToolSpec[] {
    return [
      { name: 'memory_search', description: 'Search your long-term memory (your notes, shared notes and facts about the user). Returns note paths with one-line summaries; read a note for details.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'], additionalProperties: false } },
      { name: 'memory_read', description: 'Read one note from your memory by its path.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
      { name: 'memory_write', description: 'Save or update a note in your own memory folder. Use [[Note name]] links between notes. One topic per note; update an existing note instead of adding a similar one. Never store secrets, tokens or other people\'s contact details.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Note name, without .md' }, content: { type: 'string', description: 'Markdown body' }, type: { type: 'string', enum: [...NOTE_TYPES] }, tags: { type: 'array', items: { type: 'string' } } }, required: ['name', 'content'], additionalProperties: false } },
      { name: 'memory_append', description: 'Add one line to a note all of the user\'s Bots share ("shared"), or to the facts about the user ("user"). Lines are only ever added, never changed.', parameters: { type: 'object', properties: { folder: { type: 'string', enum: ['shared', 'user'] }, name: { type: 'string' }, text: { type: 'string' } }, required: ['folder', 'name', 'text'], additionalProperties: false } },
    ];
  }

  handles(name: string): boolean {
    return (MEMORY_TOOLS as readonly string[]).includes(name);
  }

  traits(name: string): ToolTraits {
    return { readOnly: name === 'memory_search' || name === 'memory_read', taint: 'none' };
  }

  system(user: User, bot: Bot): string {
    const idx = this.vault.read(user.id, `${agentDir(bot.id)}MEMORY.md`);
    const lines = idx ? idx.split('\n').filter((l) => l.startsWith('- ')).slice(0, 60) : [];
    const userNotes = this.vault.list(user.id, 'user/').filter((p) => p.endsWith('.md')).map(noteName).slice(0, 30);
    return [
      'You have a long-term memory. Search it with memory_search before answering questions about past work or the user, and save what will matter later (preferences, corrections, decisions, how-tos) with memory_write or memory_append.',
      lines.length ? `Your memory index:\n${lines.join('\n')}` : 'Your memory is empty so far.',
      userNotes.length ? `Notes about the user: ${userNotes.join(', ')}.` : '',
    ].filter(Boolean).join('\n');
  }

  async run(c: ToolCtx, call: ToolCall, origin = 'chat'): Promise<ModelMessage> {
    const ok = (content: string): ModelMessage => ({ role: 'tool', toolCallId: call.id, content });
    const fail = (content: string): ModelMessage => ({ role: 'tool', toolCallId: call.id, content, isError: true });
    try {
      switch (call.name) {
        case 'memory_search': {
          const p = SearchIn.safeParse(call.input);
          if (!p.success) return fail('Give "query".');
          const hits = this.search(c.user, c.bot, p.data.query, p.data.limit ?? 5);
          return ok(hits.length ? hits.map((h) => `- ${h.path} (${h.type}${h.tags.length ? `; ${h.tags.join(', ')}` : ''}): ${h.summary}`).join('\n') : 'Nothing found.');
        }
        case 'memory_read': {
          const p = ReadIn.safeParse(call.input);
          if (!p.success) return fail('Give "path".');
          const text = this.read(c.user, c.bot, p.data.path);
          return text === null ? fail('No such note in your memory.') : ok(text.slice(0, 40_000));
        }
        case 'memory_write': {
          const p = WriteIn.safeParse(call.input);
          if (!p.success) return fail(`Invalid input: ${p.error.issues[0]?.message ?? ''}`);
          return ok(`Saved ${await this.writeNote(c.user, c.bot, p.data, `${origin}:${c.convId}`)}.`);
        }
        case 'memory_append': {
          const p = AppendIn.safeParse(call.input);
          if (!p.success) return fail('Give "folder" (shared or user), "name" and "text".');
          return ok(`Added to ${await this.append(c.user, c.bot, p.data.folder, p.data.name, p.data.text)}.`);
        }
      }
      return fail(`Unknown tool ${call.name}.`);
    } catch (e) {
      if (e instanceof GuardError) return fail(e.message);
      if ((e as { code?: string }).code === 'invalid_path') return fail('That name has characters notes cannot use.');
      throw e;
    }
  }

  close(): void {
    this.index.close();
  }
}
