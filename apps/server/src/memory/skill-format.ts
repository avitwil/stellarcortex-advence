// Agent Skills format (D-22, FR-SKL-05): a folder named after the skill with a SKILL.md whose
// YAML frontmatter uses the standard fields only. The checks mirror the reference validator
// (`skills-ref validate`) so a skill made or installed here loads in other Agent Skills tools.
import YAML from 'yaml';
import { MAX_SKILL_LINES } from './guard.js';

export const SKILL_FIELDS = ['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility'] as const;
export const MAX_DESCRIPTION = 1024;
export const MAX_COMPATIBILITY = 500;

export interface SkillMeta { name: string; description: string; license?: string; 'allowed-tools'?: string; metadata?: Record<string, string>; compatibility?: string }
export interface ParsedSkill { meta: Record<string, unknown>; body: string }

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkillMd(text: string): ParsedSkill {
  const m = FM.exec(text);
  if (!m) throw new Error('SKILL.md must start with YAML frontmatter between --- lines');
  let meta: unknown;
  try {
    meta = YAML.parse(m[1]!);
  } catch (e) {
    throw new Error(`Invalid YAML in frontmatter: ${(e as Error).message.split('\n')[0]}`);
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('SKILL.md frontmatter must be a YAML mapping');
  return { meta: meta as Record<string, unknown>, body: text.slice(m[0].length) };
}

export function nameErrors(name: unknown, dirName?: string): string[] {
  if (typeof name !== 'string' || !name.trim()) return ["Field 'name' must be a non-empty string"];
  const n = name.trim().normalize('NFKC');
  const out: string[] = [];
  if ([...n].length > 64) out.push(`Skill name '${n}' exceeds 64 characters`);
  if (n !== n.toLowerCase()) out.push(`Skill name '${n}' must be lowercase`);
  if (n.startsWith('-') || n.endsWith('-')) out.push('Skill name cannot start or end with a hyphen');
  if (n.includes('--')) out.push('Skill name cannot contain consecutive hyphens');
  if (!/^[\p{L}\p{N}-]+$/u.test(n)) out.push(`Skill name '${n}' may use letters, digits and hyphens only`);
  if (dirName !== undefined && dirName.normalize('NFKC') !== n) out.push(`Directory name '${dirName}' must match skill name '${n}'`);
  return out;
}

/** Errors per the Agent Skills spec; empty when valid. */
export function validateSkill(text: string, dirName?: string): string[] {
  let p: ParsedSkill;
  try {
    p = parseSkillMd(text);
  } catch (e) {
    return [(e as Error).message];
  }
  const errors: string[] = [];
  const extra = Object.keys(p.meta).filter((k) => !(SKILL_FIELDS as readonly string[]).includes(k));
  if (extra.length) errors.push(`Unexpected fields in frontmatter: ${extra.sort().join(', ')}. Only ${SKILL_FIELDS.join(', ')} are allowed.`);
  if (!('name' in p.meta)) errors.push('Missing required field in frontmatter: name');
  else errors.push(...nameErrors(p.meta.name, dirName));
  const d = p.meta.description;
  if (!('description' in p.meta)) errors.push('Missing required field in frontmatter: description');
  else if (typeof d !== 'string' || !d.trim()) errors.push("Field 'description' must be a non-empty string");
  else if (d.length > MAX_DESCRIPTION) errors.push(`Description exceeds ${MAX_DESCRIPTION} characters`);
  const c = p.meta.compatibility;
  if (c !== undefined && (typeof c !== 'string' || c.length > MAX_COMPATIBILITY)) errors.push(`Field 'compatibility' must be a string of at most ${MAX_COMPATIBILITY} characters`);
  for (const k of ['license', 'allowed-tools'] as const) if (p.meta[k] !== undefined && typeof p.meta[k] !== 'string') errors.push(`Field '${k}' must be a string`);
  const md = p.meta.metadata;
  if (md !== undefined && (!md || typeof md !== 'object' || Array.isArray(md) || Object.values(md).some((v) => typeof v !== 'string'))) errors.push("Field 'metadata' must map keys to strings");
  if (p.body.split('\n').length >= MAX_SKILL_LINES) errors.push(`The SKILL.md body must stay under ${MAX_SKILL_LINES} lines`);
  return errors;
}

/** SKILL.md with the standard fields in block style (strict YAML parsers accept it). */
export function renderSkillMd(meta: SkillMeta, body: string): string {
  const out: Record<string, unknown> = { name: meta.name, description: meta.description };
  if (meta.license) out.license = meta.license;
  if (meta.compatibility) out.compatibility = meta.compatibility;
  if (meta['allowed-tools']) out['allowed-tools'] = meta['allowed-tools'];
  if (meta.metadata && Object.keys(meta.metadata).length) out.metadata = meta.metadata;
  const y = YAML.stringify(out, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' }).trimEnd();
  return `---\n${y}\n---\n\n${body.trim()}\n`;
}

export function skillMetaOf(text: string): SkillMeta {
  const p = parseSkillMd(text);
  const md = p.meta.metadata && typeof p.meta.metadata === 'object' ? (p.meta.metadata as Record<string, string>) : undefined;
  return {
    name: String(p.meta.name ?? '').trim().normalize('NFKC'),
    description: String(p.meta.description ?? '').trim(),
    license: typeof p.meta.license === 'string' ? p.meta.license : undefined,
    'allowed-tools': typeof p.meta['allowed-tools'] === 'string' ? p.meta['allowed-tools'] : undefined,
    compatibility: typeof p.meta.compatibility === 'string' ? p.meta.compatibility : undefined,
    metadata: md,
  };
}
