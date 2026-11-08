// Long-term memory, skills, third-party installs and the curator (P4: FR-MEM-*, FR-LRN-*, FR-SKL-*).
import { z } from 'zod';

export const MemoryMode = z.enum(['encrypted', 'plain']);
export type MemoryMode = z.infer<typeof MemoryMode>;

export const MemoryCommit = z.object({ oid: z.string(), message: z.string(), at: z.number() });
export type MemoryCommit = z.infer<typeof MemoryCommit>;

export const MemoryInfo = z.object({
  /** server-wide: encrypted at rest unless the owner chose a plain vault for Obsidian (FR-MEM-05) */
  mode: MemoryMode,
  /** where the plain vault lives on the server, shown to the owner only */
  vaultPath: z.string().nullable(),
  /** LLM consolidation of overlapping skills, off by default (FR-LRN-06) */
  consolidation: z.boolean(),
  curator: z.object({ staleDays: z.number().int(), archiveDays: z.number().int(), lastRun: z.number().nullable() }),
  notes: z.number().int(),
  history: z.array(MemoryCommit),
});
export type MemoryInfo = z.infer<typeof MemoryInfo>;

export const MemorySettingsPatch = z.object({
  mode: MemoryMode.optional(),
  consolidation: z.boolean().optional(),
  staleDays: z.number().int().min(1).max(3650).optional(),
  archiveDays: z.number().int().min(2).max(3650).optional(),
}).strict();
export type MemorySettingsPatch = z.infer<typeof MemorySettingsPatch>;

export const MemoryRollback = z.object({ oid: z.string().regex(/^[0-9a-f]{40}$/) }).strict();

export const SkillSourceKind = z.enum(['bot', 'github', 'skills.sh', 'local']);
export const SkillSource = z.object({ kind: SkillSourceKind, ref: z.string(), repo: z.string().optional(), path: z.string().optional(), sha: z.string().optional() });
export type SkillSource = z.infer<typeof SkillSource>;

export const SkillStatus = z.enum(['active', 'stale', 'archived']);
export type SkillStatus = z.infer<typeof SkillStatus>;

export const Skill = z.object({
  id: z.string(),
  /** the Bot that made it; null for a skill the owner installed for all their Bots */
  botId: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  source: SkillSource,
  status: SkillStatus,
  pinned: z.boolean(),
  locked: z.boolean(),
  views: z.number().int(),
  uses: z.number().int(),
  patches: z.number().int(),
  lastUsed: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Skill = z.infer<typeof Skill>;

export const SkillDetail = Skill.extend({ files: z.array(z.object({ path: z.string(), content: z.string() })) });
export type SkillDetail = z.infer<typeof SkillDetail>;

export const SkillPatch = z.object({ pinned: z.boolean().optional(), locked: z.boolean().optional() }).strict();

export const SkillExport = z.object({ name: z.string(), zipB64: z.string() });
export type SkillExport = z.infer<typeof SkillExport>;

export const SkillInstallRequest = z.object({ source: z.string().min(3).max(500) }).strict();

export const ScanFinding = z.object({ kind: z.enum(['script', 'network', 'prompt_injection', 'secrets']), file: z.string(), line: z.number().int(), excerpt: z.string() });
export type ScanFinding = z.infer<typeof ScanFinding>;

/** A third-party skill (or an update) waiting for the owner (FR-SKL-02, FR-SKL-04). */
export const SkillReview = z.object({
  id: z.string(),
  skillId: z.string().nullable(),
  source: SkillSource,
  name: z.string(),
  description: z.string(),
  skillMd: z.string(),
  files: z.array(z.object({ path: z.string(), size: z.number().int() })),
  skipped: z.array(z.string()),
  findings: z.array(ScanFinding),
  /** Agent Skills spec problems; a review with errors cannot be approved */
  errors: z.array(z.string()),
  /** unified diff against the installed version (updates only) */
  diff: z.string().nullable(),
  createdAt: z.number(),
});
export type SkillReview = z.infer<typeof SkillReview>;

export const SkillUpdateCheck = z.object({ upToDate: z.boolean(), review: SkillReview.nullable() });
export type SkillUpdateCheck = z.infer<typeof SkillUpdateCheck>;

export const CuratorAction = z.object({
  skillId: z.string(), name: z.string(), botId: z.string().nullable(),
  from: SkillStatus, to: SkillStatus, fromDir: z.string(), toDir: z.string(),
  reason: z.enum(['stale', 'unused', 'merged']), into: z.string().optional(),
});
export const CuratorRun = z.object({
  id: z.string(), at: z.number(), dryRun: z.boolean(), actions: z.array(CuratorAction),
  rolledBack: z.number().nullable(),
});
export type CuratorRun = z.infer<typeof CuratorRun>;

export const CuratorRunRequest = z.object({ dryRun: z.boolean() }).strict();
export const CuratorRollbackRequest = z.object({ runId: z.string().min(1).max(64) }).strict();
