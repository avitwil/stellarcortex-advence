// P4 services: long-term memory, skills, third-party installs, the curator and the learn pass.
import type { User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import type { Chat } from '../chat/index.js';
import type { ComputerManager } from '../computer/manager.js';
import { Memory } from './memory.js';
import { Skills } from './skills.js';
import { Installer, type InstallDeps } from './install.js';
import { Curator } from './curator.js';
import { LearnPass } from './learn.js';

export interface MemoryServices {
  memory: Memory;
  skills: Skills;
  installer: Installer;
  curator: Curator;
  learn: LearnPass;
  close(): void;
}

const MERGE_SYSTEM = 'You merge two of your own skills that overlap into one. Keep every step and detail that matters from both, remove repeats, and keep numbered steps. Reply with the merged Markdown body only, without frontmatter.';

export function createMemory(ctx: AppContext, chat: Chat, computers: ComputerManager | null, o: { install?: InstallDeps } = {}): MemoryServices {
  const memory = new Memory(ctx, chat.activity);
  const skills = new Skills(ctx, memory, chat.activity, computers);
  const installer = new Installer(ctx, memory, skills, o.install);
  const users = () => (ctx.db.prepare('SELECT id FROM users').all() as { id: string }[]).map((r) => ctx.identity.getUser(r.id)).filter((u): u is User => !!u);
  const curator = new Curator(ctx, memory, skills, {
    idle: () => chat.runtime.busy() === 0,
    users,
    merge: async (user, botId, a, b) => {
      const bot = chat.bots.get(botId);
      if (!bot?.sourceId) return null;
      const r = await chat.runtime.background(user, bot, { system: MERGE_SYSTEM, prompt: `Skill "${a.name}":\n\n${a.body}\n\nSkill "${b.name}":\n\n${b.body}`, providers: [], maxTurns: 1 });
      return r.text.trim() || null;
    },
  });
  const learn = new LearnPass(ctx, { runtime: chat.runtime, store: chat.store, activity: chat.activity, memory, skills });
  chat.runtime.setTools(memory);
  chat.runtime.setTools(skills);
  chat.runtime.observe(learn);
  curator.start();
  return {
    memory, skills, installer, curator, learn,
    close() {
      curator.close();
      memory.close();
    },
  };
}
