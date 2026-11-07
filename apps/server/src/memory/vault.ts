// Long-term memory vault (D-20, FR-MEM-01..05): a Markdown folder per user, kept as a git repo
// with one commit per write batch. Encrypted at rest by default (each file sealed under the
// vault key, stored under a keyed hash of its path, so names do not leak either); the owner can
// switch to a plain folder that opens in Obsidian.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import git from 'isomorphic-git';
import { seal, open, utf8, fromUtf8 } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { getMeta, setMeta } from '../db.js';
import { HttpError } from '../http.js';

export type VaultMode = 'encrypted' | 'plain';
const SEALED = '.sealed';
const AUTHOR = { name: 'StellarCortex Advence', email: 'vault@advence.local' };
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N} _.()-]{0,99}$/u;

/** Normalizes a vault-relative path; rejects traversal, hidden segments and odd characters. */
export function cleanPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
  if (parts.length === 0 || parts.length > 8) throw new HttpError(400, 'invalid_path');
  for (const s of parts) if (!SEGMENT.test(s) || s.endsWith('.') || s.endsWith(' ')) throw new HttpError(400, 'invalid_path');
  const out = parts.join('/');
  if (out.length > 240) throw new HttpError(400, 'invalid_path');
  return out;
}

export interface Commit { oid: string; message: string; at: number }

export class Vault {
  readonly root: string;
  private cache = new Map<string, Map<string, string>>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(private ctx: AppContext) {
    this.root = path.join(ctx.config.dataDir, 'vault');
  }

  mode(): VaultMode {
    return getMeta(this.ctx.db, 'memory.mode') === 'plain' ? 'plain' : 'encrypted';
  }

  dir(userId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new Error('bad user id');
    return path.join(this.root, userId);
  }

  private fileId(userId: string, p: string): string {
    return createHmac('sha256', this.ctx.crypto.vaultKey).update(`${userId}\0${p}`).digest('hex').slice(0, 40);
  }

  /** One writer per user vault at a time (single writer per file, FR-MEM-01). */
  private async serial<T>(userId: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    const next = prev.then(f, f);
    this.locks.set(userId, next.catch(() => undefined));
    return next;
  }

  private load(userId: string, mode: VaultMode = this.mode()): Map<string, string> {
    // Plain vaults may be edited in Obsidian at any time, so they are read fresh.
    const have = this.cache.get(userId);
    if (have && mode === 'encrypted') return have;
    const files = new Map<string, string>();
    const dir = this.dir(userId);
    if (mode === 'plain') {
      const walk = (rel: string) => {
        const abs = path.join(dir, rel);
        if (!fs.existsSync(abs)) return;
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
          if (e.name.startsWith('.')) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(r);
          else if (e.isFile()) files.set(r, fs.readFileSync(path.join(dir, r), 'utf8'));
        }
      };
      walk('');
    } else {
      const sdir = path.join(dir, SEALED);
      if (fs.existsSync(sdir)) {
        for (const f of fs.readdirSync(sdir)) {
          if (!f.endsWith('.bin')) continue;
          const id = f.slice(0, -4);
          const j = JSON.parse(fromUtf8(open(this.ctx.crypto.vaultKey, fs.readFileSync(path.join(sdir, f)), `vault:${userId}:${id}`))) as { p: string; c: string };
          files.set(j.p, j.c);
        }
      }
    }
    if (mode === 'encrypted') this.cache.set(userId, files);
    return files;
  }

  users(): string[] {
    if (!fs.existsSync(this.root)) return [];
    return fs.readdirSync(this.root).filter((d) => /^[A-Za-z0-9_-]{1,64}$/.test(d));
  }

  list(userId: string, prefix = ''): string[] {
    return [...this.load(userId).keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  read(userId: string, p: string): string | null {
    return this.load(userId).get(cleanPath(p)) ?? null;
  }

  private writeFile(userId: string, p: string, content: string | null, mode: VaultMode = this.mode()): void {
    const dir = this.dir(userId);
    if (mode === 'plain') {
      const abs = path.join(dir, ...p.split('/'));
      if (content === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    } else {
      const id = this.fileId(userId, p);
      const abs = path.join(dir, SEALED, `${id}.bin`);
      if (content === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, seal(this.ctx.crypto.vaultKey, utf8(JSON.stringify({ p, c: content })), `vault:${userId}:${id}`));
      }
    }
  }

  private async ensureRepo(userId: string): Promise<string> {
    const dir = this.dir(userId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(dir, '.git'))) {
      await git.init({ fs, dir, defaultBranch: 'main' });
      fs.writeFileSync(path.join(dir, '.gitignore'), '.obsidian/\n.trash/\n');
    }
    return dir;
  }

  private async commitAll(userId: string, message: string): Promise<string | null> {
    const dir = await this.ensureRepo(userId);
    const matrix = await git.statusMatrix({ fs, dir });
    let changed = false;
    for (const [file, head, work, stage] of matrix) {
      if (head === work && work === stage) continue;
      changed = true;
      if (work === 0) await git.remove({ fs, dir, filepath: file });
      else await git.add({ fs, dir, filepath: file });
    }
    if (!changed) return null;
    return git.commit({ fs, dir, message: message.slice(0, 500), author: { ...AUTHOR, timestamp: Math.floor(Date.now() / 1000) } });
  }

  /**
   * Applies a batch of writes (null deletes; only archives and the curator move files) and
   * commits it as one change (FR-MEM-04). Returns the commit id.
   */
  async apply(userId: string, changes: { path: string; content: string | null }[], message: string): Promise<string | null> {
    const clean = changes.map((c) => ({ path: cleanPath(c.path), content: c.content }));
    return this.serial(userId, async () => {
      await this.ensureRepo(userId);
      const files = this.load(userId);
      for (const c of clean) {
        if (c.content === null) files.delete(c.path);
        else files.set(c.path, c.content);
        this.writeFile(userId, c.path, c.content);
      }
      return this.commitAll(userId, message);
    });
  }

  async history(userId: string, depth = 50): Promise<Commit[]> {
    const dir = this.dir(userId);
    if (!fs.existsSync(path.join(dir, '.git'))) return [];
    const log = await git.log({ fs, dir, depth });
    return log.map((c) => ({ oid: c.oid, message: c.commit.message.trim(), at: c.commit.author.timestamp * 1000 }));
  }

  /** The vault's files as they were at a commit (logical paths and contents). */
  async filesAt(userId: string, oid: string): Promise<Map<string, string>> {
    const dir = this.dir(userId);
    const out = new Map<string, string>();
    const raw = new Map<string, Uint8Array>();
    await git.walk({
      fs, dir, trees: [git.TREE({ ref: oid })],
      map: async (filepath, [entry]) => {
        if (!entry || filepath === '.') return true;
        if ((await entry.type()) === 'blob') raw.set(filepath, (await entry.content())!);
        return true;
      },
    });
    for (const [fp, bytes] of raw) {
      if (fp === '.gitignore') continue;
      if (fp.startsWith(`${SEALED}/`)) {
        const id = fp.slice(SEALED.length + 1, -4);
        const j = JSON.parse(fromUtf8(open(this.ctx.crypto.vaultKey, bytes, `vault:${userId}:${id}`))) as { p: string; c: string };
        out.set(j.p, j.c);
      } else out.set(fp, fromUtf8(bytes));
    }
    return out;
  }

  /** Restores the whole vault to a commit, as a new commit (history is kept). */
  async rollback(userId: string, oid: string): Promise<string | null> {
    const then = await this.filesAt(userId, oid);
    const now = this.list(userId);
    const changes = [...now.filter((p) => !then.has(p)).map((p) => ({ path: p, content: null })), ...[...then].map(([p, c]) => ({ path: p, content: c }))];
    return this.apply(userId, changes, `Rollback to ${oid.slice(0, 8)}`);
  }

  /** Switches every user's vault between encrypted and plain (FR-MEM-05). */
  async setMode(mode: VaultMode): Promise<void> {
    const from = this.mode();
    if (mode === from) return;
    const users = this.users();
    const all = new Map(users.map((u) => [u, new Map(this.load(u, from))]));
    for (const u of users) {
      await this.serial(u, async () => {
        const files = all.get(u)!;
        for (const p of files.keys()) this.writeFile(u, p, null, from);
        if (from === 'encrypted') fs.rmSync(path.join(this.dir(u), SEALED), { recursive: true, force: true });
        else removeEmptyDirs(this.dir(u));
        for (const [p, c] of files) this.writeFile(u, p, c, mode);
        if (mode === 'encrypted') this.cache.set(u, files);
        else this.cache.delete(u);
        await this.commitAll(u, mode === 'plain' ? 'Vault switched to plain Markdown' : 'Vault encrypted');
      });
    }
    setMeta(this.ctx.db, 'memory.mode', mode);
  }
}

function removeEmptyDirs(dir: string): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    removeEmptyDirs(abs);
    if (fs.readdirSync(abs).length === 0) fs.rmdirSync(abs);
  }
}
