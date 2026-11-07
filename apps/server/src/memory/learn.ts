// Learn pass (FR-LRN-01): after a task, after a correction, and at the latest every 10 user turns
// or 10 tool iterations, a background review of the conversation runs with the memory and skill
// tools only. It patches the skill that was used first, then an existing skill, then memory, and
// creates a new skill last. Every write still goes through the guard.
import type { Bot, User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import type { ChatRuntime, ReplyInfo, ReplyObserver, ToolProvider } from '../chat/runtime.js';
import type { ChatStore } from '../chat/store.js';
import type { Activity } from '../chat/activity.js';
import type { Memory } from './memory.js';
import type { Skills } from './skills.js';

export const LEARN_EVERY = 10;
/** Tools that finish a piece of work (a "task"). */
const TASK_TOOLS = new Set(['code', 'computer', 'host', 'delegate', 'skill_run']);
const CORRECTION = /\b(wrong|incorrect|not what i|that's not|that is not|actually|instead|i prefer|i'd prefer|i would prefer|don't|do not|never|always|remember|from now on|next time|learn this|you should have|please stop)\b|^\s*no\b|(לא נכון|טעית|תזכור|תזכרי|תמיד|אף פעם|במקום|אני מעדיף|אני מעדיפה|מעכשיו|בפעם הבאה|תלמד|לא ככה)/i;

export const LEARN_SYSTEM = [
  'You are running a learn pass: a short review of a conversation you just had, so you do better next time. Nobody reads your reply; only your tool calls count.',
  'Look for: corrections the user made, preferences they stated, failures that were fixed and how, and reusable techniques.',
  'Save what will matter later, in this order of preference:',
  '1. If a skill was used and the conversation shows it was wrong or incomplete, patch that skill with skill_patch.',
  '2. Otherwise, if one of your existing skills covers the lesson, patch that skill.',
  '3. Otherwise, update memory: memory_write for your own notes (search first with memory_search and update an existing note instead of adding a similar one), or memory_append with folder "user" for facts and preferences about the user.',
  '4. Only for a new multi-step procedure the user taught or asked you to learn, create a skill with skill_create.',
  'Never save secrets, tokens, passwords or other people\'s contact details. If there is nothing worth keeping, call no tool and reply "Nothing to save."',
].join('\n');

const LEARN_TOOLS = new Set(['memory_search', 'memory_read', 'memory_write', 'memory_append', 'skill_view', 'skill_create', 'skill_patch']);

/** Only the memory and skill tools, without running a skill (FR-LRN-01). */
function only(p: ToolProvider): ToolProvider {
  return {
    specs: (u, b) => p.specs(u, b).filter((s) => LEARN_TOOLS.has(s.name)),
    handles: (n) => LEARN_TOOLS.has(n) && p.handles(n),
    run: (c, call) => p.run(c, call),
  };
}

interface Counter { userTurns: number; toolIters: number; lastUserMsg: string | null; skills: Set<string>; busy: boolean; again: boolean }

export class LearnPass implements ReplyObserver {
  private counters = new Map<string, Counter>();
  private pending = new Set<Promise<void>>();

  constructor(private ctx: AppContext, private d: { runtime: ChatRuntime; store: ChatStore; activity: Activity; memory: Memory; skills: Skills }) {}

  afterReply(info: ReplyInfo): void {
    const key = `${info.bot.id}:${info.convId}`;
    const c = this.counters.get(key) ?? { userTurns: 0, toolIters: 0, lastUserMsg: null, skills: new Set<string>(), busy: false, again: false };
    this.counters.set(key, c);
    const last = this.d.store.contextRows(info.convId, null, 10).filter((r) => r.author === 'user').pop();
    let corrected = false;
    if (last && last.id !== c.lastUserMsg) {
      c.lastUserMsg = last.id;
      c.userTurns++;
      corrected = CORRECTION.test(this.d.store.body(last).text);
    }
    c.toolIters += info.toolCalls.length;
    for (const t of info.toolCalls) {
      const n = (t.input as { name?: unknown })?.name;
      if ((t.name === 'skill_run' || t.name === 'skill_view') && typeof n === 'string') c.skills.add(n);
    }
    const task = info.toolCalls.some((t) => TASK_TOOLS.has(t.name));
    if (!(task || corrected || c.userTurns >= LEARN_EVERY || c.toolIters >= LEARN_EVERY)) return;
    if (!info.bot.sourceId) return;
    if (c.busy) {
      c.again = true;
      return;
    }
    this.start(info.user, info.bot, info.convId, c, task ? 'task' : corrected ? 'correction' : 'count');
  }

  private start(user: User, bot: Bot, convId: string, c: Counter, why: string): void {
    const skills = [...c.skills];
    c.userTurns = 0;
    c.toolIters = 0;
    c.skills.clear();
    c.busy = true;
    const p = this.review(user, bot, convId, skills, why)
      .catch((e) => this.ctx.log.warn({ bot: bot.id, err: (e as Error).message }, 'learn pass failed'))
      .finally(() => {
        c.busy = false;
        this.pending.delete(p);
        if (c.again) {
          c.again = false;
          this.start(user, bot, convId, c, 'again');
        }
      });
    this.pending.add(p);
  }

  private async review(user: User, bot: Bot, convId: string, skills: string[], why: string): Promise<void> {
    const transcript = this.d.runtime.transcript(user, bot, convId, 30);
    const prompt = `Conversation with ${user.name}:\n\n${transcript}\n\nSkills used in this conversation: ${skills.length ? skills.join(', ') : 'none'}.\n\nReview it now.`;
    const system = [LEARN_SYSTEM, this.d.memory.system(user, bot), this.d.skills.system(user, bot)].filter(Boolean).join('\n\n');
    const r = await this.d.runtime.background(user, bot, { system, prompt, providers: [only(this.d.memory), only(this.d.skills)], convId, maxTurns: 6 });
    const writes = r.calls.filter((t) => /^(memory_write|memory_append|skill_create|skill_patch)$/.test(t.name)).length;
    this.d.activity.log(user.id, bot.id, 'learn.review', { bot: bot.name, trigger: why, writes: String(writes) });
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
