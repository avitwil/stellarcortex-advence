// P4 REST API: memory settings, history and rollback (FR-MEM-04/05), skills with telemetry
// (FR-LRN-04), third-party installs and updates with owner approval (FR-SKL-01/02/04), export
// (FR-SKL-05) and the curator (FR-LRN-05/06).
import type { FastifyRequest } from 'fastify';
import {
  CuratorRollbackRequest, CuratorRunRequest, MemoryRollback, MemorySettingsPatch, SkillInstallRequest, SkillPatch,
  type CuratorRun, type MemoryInfo, type Skill, type SkillDetail, type SkillExport, type SkillReview, type SkillUpdateCheck, type User,
} from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError, parse, router, userOf } from '../http.js';
import type { Chat } from '../chat/index.js';
import type { MemoryServices } from '../memory/index.js';
import type { SkillInfo } from '../memory/skills.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

function skillView(s: SkillInfo): Skill {
  const { userId: _u, dir: _d, ...rest } = s;
  void _u;
  void _d;
  return rest;
}

export function registerMemoryRoutes(app: import('fastify').FastifyInstance, ctx: AppContext, chat: Chat, m: MemoryServices): void {
  const route = router(app, ctx);
  const { memory, skills, installer, curator } = m;

  const info = async (user: User): Promise<MemoryInfo> => {
    const s = curator.settings();
    const mode = memory.vault.mode();
    return {
      mode,
      vaultPath: mode === 'plain' && user.role === 'owner' ? memory.vault.dir(user.id) : null,
      consolidation: s.consolidation,
      curator: { staleDays: s.staleDays, archiveDays: s.archiveDays, lastRun: s.lastRun },
      notes: memory.vault.list(user.id).filter((p) => p.endsWith('.md') && !p.includes('/skills/')).length,
      history: await memory.vault.history(user.id, 30),
    };
  };

  // ---------------------------------------------------------------- memory
  route('GET', '/v1/memory', 'session', (req) => info(userOf(req)));
  // The vault mode applies to every user's vault on this server, so it is the owner's call.
  route('PATCH', '/v1/memory/settings', 'owner', async (req) => {
    const user = userOf(req);
    const p = parse(MemorySettingsPatch, req.body);
    if (p.mode && p.mode !== memory.vault.mode()) {
      await memory.vault.setMode(p.mode);
      ctx.log.warn({ mode: p.mode }, 'memory vault mode changed');
      for (const u of memory.vault.users()) memory.refresh(u);
    }
    if (p.staleDays !== undefined || p.archiveDays !== undefined || p.consolidation !== undefined) curator.setSettings(p);
    return info(user);
  });
  route('POST', '/v1/memory/rollback', 'session', async (req) => {
    const user = userOf(req);
    const { oid } = parse(MemoryRollback, req.body);
    if (!(await memory.vault.history(user.id, 1000)).some((c) => c.oid === oid)) throw new HttpError(404, 'not_found');
    await memory.vault.rollback(user.id, oid);
    memory.refresh(user.id);
    chat.activity.log(user.id, null, 'memory.rollback', { commit: oid.slice(0, 8) });
    return info(user);
  });

  // ---------------------------------------------------------------- skills
  route('GET', '/v1/skills', 'session', (req): Skill[] => skills.list(userOf(req).id).map(skillView));
  route('GET', '/v1/skills/reviews', 'session', (req): SkillReview[] => installer.pending(userOf(req).id));
  route('POST', '/v1/skills/install', 'session', async (req): Promise<SkillReview> => {
    const user = userOf(req);
    const r = await installer.start(user, parse(SkillInstallRequest, req.body).source);
    chat.activity.log(user.id, null, 'skill.review', { name: r.name, source: r.source.ref });
    return r;
  });
  route('POST', '/v1/skills/reviews/:id/approve', 'session', async (req): Promise<Skill> => {
    const user = userOf(req);
    const s = await installer.approve(user, params(req).id!);
    chat.activity.log(user.id, null, 'skill.install', { name: s.name, source: s.source.ref, sha: s.source.sha ?? '' });
    return skillView(s);
  });
  route('POST', '/v1/skills/reviews/:id/reject', 'session', (req) => {
    installer.reject(userOf(req), params(req).id!);
  });

  route('GET', '/v1/skills/curator', 'session', (req): CuratorRun[] => curator.runs(userOf(req).id).map(({ type: _t, snapshot: _s, ...r }) => r));
  route('POST', '/v1/skills/curator/run', 'session', async (req): Promise<CuratorRun> => {
    const user = userOf(req);
    const { dryRun } = parse(CuratorRunRequest, req.body);
    const r = await curator.run(user, { dryRun });
    if (!dryRun) chat.activity.log(user.id, null, 'curator.run', { changes: String(r.actions.length) });
    return { id: r.id, at: r.at, dryRun: r.dryRun, actions: r.actions, rolledBack: null };
  });
  route('POST', '/v1/skills/curator/rollback', 'session', async (req) => {
    const user = userOf(req);
    const { runId } = parse(CuratorRollbackRequest, req.body);
    await curator.rollback(user, runId);
    chat.activity.log(user.id, null, 'curator.rollback', { run: runId });
  });

  route('GET', '/v1/skills/:id', 'session', (req): SkillDetail => {
    const s = skills.get(userOf(req).id, params(req).id!);
    return { ...skillView(s), files: [...skills.files(s)].map(([path, content]) => ({ path, content })) };
  });
  route('PATCH', '/v1/skills/:id', 'session', (req): Skill => skillView(skills.setFlags(userOf(req).id, params(req).id!, parse(SkillPatch, req.body))));
  route('GET', '/v1/skills/:id/export', 'session', (req): SkillExport => {
    const e = skills.export(userOf(req).id, params(req).id!);
    return { name: e.name, zipB64: e.zip.toString('base64') };
  });
  route('POST', '/v1/skills/:id/check-update', 'session', async (req): Promise<SkillUpdateCheck> => {
    const r = await installer.checkUpdate(userOf(req), params(req).id!);
    return { upToDate: r === null, review: r };
  });
}
