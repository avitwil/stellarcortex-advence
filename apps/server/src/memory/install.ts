// Third-party skills (FR-SKL-01/02/04): fetch from a GitHub owner/repo[/path], a skills.sh entry or
// a local folder; pin to the commit SHA; show the full SKILL.md, the file list, the static scan and
// the spec check; activate only after the owner approves. Updates show the diff of the new SHA
// and also wait for approval. Bots have no way to install anything.
import fs from 'node:fs';
import path from 'node:path';
import type { User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';
import { newId } from '../ids.js';
import { cleanPath } from './vault.js';
import type { Memory } from './memory.js';
import { skillDir, type SkillInfo, type SkillSource, type Skills } from './skills.js';
import { skillMetaOf, validateSkill } from './skill-format.js';
import { scanSkill, type Finding } from './scan.js';
import { readTarGz } from './tar.js';
import { diffFiles } from './diff.js';

const MAX_TARBALL = 25 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_FILE = 512 * 1024;
const MAX_TOTAL = 5 * 1024 * 1024;
const PART = /^[A-Za-z0-9_.-]{1,100}$/;

export interface Review {
  id: string;
  skillId: string | null;
  source: SkillSource;
  name: string;
  description: string;
  skillMd: string;
  files: { path: string; size: number }[];
  skipped: string[];
  findings: Finding[];
  errors: string[];
  diff: string | null;
  createdAt: number;
}
interface StoredReview extends Review { content: Record<string, string> }

export interface InstallDeps {
  fetch?: typeof fetch;
  githubApi?: string;
  codeload?: string;
}

interface Fetched { source: SkillSource; files: Map<string, string>; skipped: string[] }

/** Parses what the owner typed into a source. */
export function parseSource(input: string): { kind: 'github' | 'skills.sh' | 'local'; owner?: string; repo?: string; path?: string; ref?: string; local?: string } {
  const s = input.trim();
  if (s.startsWith('local:') || path.isAbsolute(s)) return { kind: 'local', local: s.replace(/^local:/, '') };
  let m = /^(?:https?:\/\/)?(?:www\.)?skills\.sh\/([^/\s]+)\/([^/\s]+)\/([^/\s?#]+)\/?$/.exec(s);
  if (m) return { kind: 'skills.sh', owner: m[1], repo: m[2], path: m[3] };
  m = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/tree\/([^/\s]+)((?:\/[^/\s]+)*))?\/?$/.exec(s);
  if (m) return { kind: 'github', owner: m[1], repo: m[2], ref: m[3], path: (m[4] ?? '').replace(/^\//, '') || undefined };
  m = /^(?:github:)?([^/\s@]+)\/([^/\s@]+)((?:\/[^/\s@]+)*)(?:@([^\s]+))?$/.exec(s);
  if (m) return { kind: 'github', owner: m[1], repo: m[2], path: (m[3] ?? '').replace(/^\//, '') || undefined, ref: m[4] };
  throw new HttpError(400, 'invalid_source');
}

export class Installer {
  private fetch: typeof fetch;
  private api: string;
  private codeload: string;

  constructor(private ctx: AppContext, private memory: Memory, private skills: Skills, d: InstallDeps = {}) {
    this.fetch = d.fetch ?? fetch;
    this.api = d.githubApi ?? 'https://api.github.com';
    this.codeload = d.codeload ?? 'https://codeload.github.com';
  }

  // ---------------------------------------------------------------- fetching
  private async github(owner: string, repo: string, sub: string | undefined, ref: string | undefined, want: string | undefined, kind: 'github' | 'skills.sh'): Promise<Fetched> {
    if (!PART.test(owner) || !PART.test(repo) || (ref && !/^[A-Za-z0-9_./-]{1,200}$/.test(ref))) throw new HttpError(400, 'invalid_source');
    const signal = AbortSignal.timeout(60_000);
    const r = await this.fetch(`${this.api}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref ?? 'HEAD')}`, { headers: { accept: 'application/vnd.github.sha', 'user-agent': 'advence-skills' }, signal });
    if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? 'source_not_found' : 'source_unreachable');
    const sha = (await r.text()).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(502, 'source_unreachable');
    const t = await this.fetch(`${this.codeload}/${owner}/${repo}/tar.gz/${sha}`, { headers: { 'user-agent': 'advence-skills' }, signal });
    if (!t.ok) throw new HttpError(502, 'source_unreachable');
    const gz = Buffer.from(await t.arrayBuffer());
    if (gz.length > MAX_TARBALL) throw new HttpError(413, 'source_too_large');
    const tar = readTarGz(gz);
    // Strip the top folder GitHub adds (repo-sha/).
    const all = new Map<string, Buffer>();
    for (const e of tar.files) all.set(e.path.split('/').slice(1).join('/'), e.data);
    let base = sub ? `${sub.replace(/\/+$/, '')}/` : '';
    if (want) {
      // skills.sh entry: the folder whose SKILL.md names this skill.
      const hit = [...all.keys()].filter((p) => /(^|\/)SKILL\.md$/.test(p)).find((p) => {
        try {
          return skillMetaOf(all.get(p)!.toString('utf8')).name === want;
        } catch {
          return false;
        }
      });
      if (!hit) throw new HttpError(404, 'skill_not_found');
      base = hit.slice(0, -'SKILL.md'.length);
    }
    if (!all.has(`${base}SKILL.md`)) throw new HttpError(404, 'skill_not_found');
    const picked = new Map<string, Buffer>();
    for (const [p, d] of all) if (p.startsWith(base) && p.length > base.length) picked.set(p.slice(base.length), d);
    const out = this.collect(picked, tar.skipped.map((p) => p.split('/').slice(1).join('/')).filter((p) => p.startsWith(base)).map((p) => p.slice(base.length)));
    return { source: { kind, ref: kind === 'skills.sh' ? `skills.sh/${owner}/${repo}/${want}` : `${owner}/${repo}${sub ? `/${sub}` : ''}${ref ? `@${ref}` : ''}`, repo: `${owner}/${repo}`, path: base.replace(/\/$/, ''), sha }, ...out };
  }

  private local(dir: string): Fetched {
    const root = path.resolve(dir);
    const st = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!st?.isDirectory()) throw new HttpError(404, 'source_not_found');
    const picked = new Map<string, Buffer>();
    const skipped: string[] = [];
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (e.name === '.git' || e.name === 'node_modules') continue;
          walk(r);
        } else if (e.isFile()) {
          if (picked.size >= MAX_FILES * 2) throw new HttpError(413, 'source_too_large');
          picked.set(r, fs.readFileSync(path.join(root, r)));
        } else skipped.push(r);
      }
    };
    walk('');
    if (!picked.has('SKILL.md')) throw new HttpError(404, 'skill_not_found');
    return { source: { kind: 'local', ref: root }, ...this.collect(picked, skipped) };
  }

  /** Keeps text files with clean names within the limits; everything else is listed as skipped. */
  private collect(picked: Map<string, Buffer>, skipped: string[]): { files: Map<string, string>; skipped: string[] } {
    const files = new Map<string, string>();
    let total = 0;
    for (const [p, d] of [...picked].sort(([a], [b]) => a.localeCompare(b))) {
      let clean: string | null = null;
      try {
        clean = cleanPath(p);
      } catch {
        clean = null;
      }
      const text = d.toString('utf8');
      const binary = d.includes(0) || Buffer.from(text, 'utf8').length !== d.length;
      if (!clean || clean !== p || binary || d.length > MAX_FILE || files.size >= MAX_FILES || total + d.length > MAX_TOTAL) {
        skipped.push(p);
        continue;
      }
      total += d.length;
      files.set(p, text);
    }
    return { files, skipped };
  }

  private async fetchSource(user: User, input: string): Promise<Fetched> {
    const s = parseSource(input);
    // The server's own disk is the server owner's.
    if (s.kind === 'local') {
      if (user.role !== 'owner') throw new HttpError(403, 'owner_only');
      return this.local(s.local!);
    }
    if (s.kind === 'skills.sh') return this.github(s.owner!, s.repo!, undefined, undefined, s.path!, 'skills.sh');
    return this.github(s.owner!, s.repo!, s.path, s.ref, undefined, 'github');
  }

  // ---------------------------------------------------------------- reviews
  private store(user: User, r: StoredReview): Review {
    this.ctx.db.prepare('INSERT INTO skill_reviews(id, user_id, skill_id, body, created_at) VALUES(?,?,?,?,?)').run(r.id, user.id, r.skillId, this.ctx.crypto.sealContent(JSON.stringify(r), `skill-review:${r.id}`), r.createdAt);
    return publicReview(r);
  }

  private load(userId: string, id: string): StoredReview {
    const row = this.ctx.db.prepare('SELECT body FROM skill_reviews WHERE id = ? AND user_id = ?').get(id, userId) as { body: Buffer } | undefined;
    if (!row) throw new HttpError(404, 'not_found');
    return JSON.parse(this.ctx.crypto.openContent(row.body, `skill-review:${id}`)) as StoredReview;
  }

  pending(userId: string): Review[] {
    const rows = this.ctx.db.prepare('SELECT id FROM skill_reviews WHERE user_id = ? ORDER BY created_at').all(userId) as { id: string }[];
    return rows.map((r) => publicReview(this.load(userId, r.id)));
  }

  private review(f: Fetched, existing: SkillInfo | null): StoredReview {
    const skillMd = f.files.get('SKILL.md') ?? '';
    let name = '';
    let description = '';
    try {
      const m = skillMetaOf(skillMd);
      name = m.name;
      description = m.description;
    } catch {
      /* reported by validateSkill */
    }
    const dirName = f.source.path ? f.source.path.split('/').pop()! : name;
    const errors = validateSkill(skillMd, f.source.kind === 'local' ? undefined : dirName || undefined);
    return {
      id: newId('rev'), skillId: existing?.id ?? null, source: f.source, name, description, skillMd,
      files: [...f.files].map(([p, c]) => ({ path: p, size: Buffer.byteLength(c) })).sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path))), skipped: f.skipped,
      findings: scanSkill(f.files), errors,
      diff: existing ? diffFiles(this.skills.files(existing), f.files) : null,
      createdAt: Date.now(), content: Object.fromEntries(f.files),
    };
  }

  /** Fetches and checks a skill; nothing is active until the owner approves the review. */
  async start(user: User, input: string): Promise<Review> {
    const f = await this.fetchSource(user, input);
    const r = this.review(f, null);
    if (r.name && this.skills.byName(user.id, null, r.name)) r.errors.push(`A skill named "${r.name}" is already installed. Check it for updates instead.`);
    return this.store(user, r);
  }

  /** Update check (FR-SKL-04): a review with the diff to the newest commit, or null if current. */
  async checkUpdate(user: User, skillId: string): Promise<Review | null> {
    const s = this.skills.get(user.id, skillId);
    if (s.source.kind === 'bot') throw new HttpError(400, 'not_installed');
    const input = s.source.kind === 'local' ? `local:${s.source.ref}` : s.source.ref;
    const f = await this.fetchSource(user, input);
    if (s.source.sha && f.source.sha === s.source.sha) return null;
    const r = this.review(f, s);
    if (r.diff === '') return null;
    if (r.name !== s.name) r.errors.push(`The update renames the skill to "${r.name}".`);
    return this.store(user, r);
  }

  reject(user: User, id: string): void {
    this.load(user.id, id);
    this.ctx.db.prepare('DELETE FROM skill_reviews WHERE id = ? AND user_id = ?').run(id, user.id);
  }

  /** The owner's approval: the files go into the vault in one commit and the skill is active. */
  async approve(user: User, id: string): Promise<SkillInfo> {
    const r = this.load(user.id, id);
    if (r.errors.length) throw new HttpError(409, 'skill_invalid');
    const existing = r.skillId ? this.skills.get(user.id, r.skillId) : this.skills.byName(user.id, null, r.name);
    if (!r.skillId && existing) throw new HttpError(409, 'skill_exists');
    const dir = skillDir(null, r.name);
    const changes: { path: string; content: string | null }[] = [];
    if (existing) for (const p of this.memory.vault.list(user.id, existing.dir)) if (!(p.slice(existing.dir.length) in r.content)) changes.push({ path: p, content: null });
    for (const [p, c] of Object.entries(r.content)) changes.push({ path: `${dir}${p}`, content: c });
    await this.memory.vault.apply(user.id, changes, `${existing ? 'Update' : 'Install'} skill ${r.name} from ${r.source.ref} at ${r.source.sha?.slice(0, 12) ?? 'local'}`);
    const sid = this.skills.record(user.id, null, { name: r.name, description: r.description, source: r.source }, existing);
    if (existing?.status !== 'active') this.skills.setStatus(sid, 'active');
    this.ctx.db.prepare('DELETE FROM skill_reviews WHERE id = ?').run(id);
    this.memory.refresh(user.id);
    return this.skills.get(user.id, sid);
  }
}

function publicReview(r: StoredReview): Review {
  const { content: _c, ...rest } = r;
  void _c;
  return rest;
}
