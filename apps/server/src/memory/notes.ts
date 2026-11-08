// Note format (FR-MEM-02): YAML frontmatter with type, tags, created, updated and source, a
// Markdown body with [[wikilinks]], and a MEMORY.md index per agent with one line per note.
import YAML from 'yaml';

export const NOTE_TYPES = ['fact', 'preference', 'procedure', 'project', 'person', 'reference', 'log'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export interface NoteMeta { type: string; tags: string[]; created: string; updated: string; source: string; [k: string]: unknown }
export interface Note { meta: NoteMeta; body: string }

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseNote(text: string): Note {
  const m = FM.exec(text);
  let meta: Record<string, unknown> = {};
  let body = text;
  if (m) {
    try {
      const y = YAML.parse(m[1]!);
      if (y && typeof y === 'object' && !Array.isArray(y)) meta = y as Record<string, unknown>;
    } catch {
      meta = {};
    }
    body = text.slice(m[0].length);
  }
  const tags = Array.isArray(meta.tags) ? meta.tags.map(String) : typeof meta.tags === 'string' ? meta.tags.split(/[,\s]+/).filter(Boolean) : [];
  return {
    meta: {
      ...meta,
      type: String(meta.type ?? 'fact'),
      tags,
      created: String(meta.created ?? ''),
      updated: String(meta.updated ?? meta.created ?? ''),
      source: String(meta.source ?? ''),
    },
    body: body.replace(/^\s*\n/, ''),
  };
}

export function renderNote(n: Note): string {
  const { type, tags, created, updated, source, ...rest } = n.meta;
  const y = YAML.stringify({ type, tags, created, updated, source, ...rest }, { lineWidth: 0 }).trimEnd();
  return `---\n${y}\n---\n\n${n.body.trim()}\n`;
}

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Note name (file name without .md) for [[wikilinks]]. */
export function noteName(path: string): string {
  return path.split('/').pop()!.replace(/\.md$/, '');
}

export function wikilinks(body: string): string[] {
  return [...new Set([...body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1]!.trim()))];
}

/** One line per note: the first meaningful line of the body. */
export function summary(body: string): string {
  const line = body.split('\n').map((l) => l.replace(/^#+\s*|^[-*]\s+/, '').trim()).find((l) => l.length > 0) ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** MEMORY.md for an agent folder: one line per note (FR-MEM-02). */
export function renderIndex(botName: string, notes: { path: string; note: Note }[]): string {
  const lines = notes
    .filter((n) => !n.path.endsWith('/MEMORY.md') && !n.path.includes('/skills/') && !n.path.includes('/archive/'))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((n) => `- [[${noteName(n.path)}]] (${n.note.meta.type}) ${summary(n.note.body)}`);
  return `# Memory of ${botName}\n\nOne line per note. Open a note for details.\n\n${lines.join('\n')}\n`;
}
