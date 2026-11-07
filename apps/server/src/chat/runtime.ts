// Chat runtime: who answers a message, streaming replies, the primary Bot's delegate tool
// (FR-BOT-02), hand-offs between Bots in group chats (FR-BOT-03), usage (FR-BOT-05), the
// Library (FR-UI-04), the activity log and push (D-18).
import { z } from 'zod';
import { CHAT_EVENTS, type Bot, type Message, type User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';
import { ANTHROPIC_DEFAULT_MODEL } from '../models/anthropic.js';
import type { ModelMessage, ModelProvider, StreamEvent, ToolCall, ToolSpec, UserPart } from '../models/types.js';
import { ProviderError } from '../models/types.js';
import type { Bots } from './bots.js';
import type { ChatStore, MsgRow } from './store.js';
import type { ModelSources } from '../models/sources.js';
import type { Library } from './library.js';
import type { UsageLog } from './usage.js';
import type { Activity } from './activity.js';
import type { Push } from './push.js';
import type { SearchIndex } from './search.js';

export interface ChatServices {
  bots: Bots;
  store: ChatStore;
  sources: ModelSources;
  library: Library;
  usage: UsageLog;
  activity: Activity;
  push: Push;
  search: SearchIndex;
}

/** Bounds that keep Bots from talking to each other forever. */
export const MAX_TOOL_TURNS = 8;
export const MAX_HANDOFF_HOPS = 3;
export const MAX_DELEGATION_DEPTH = 2;
const CONTEXT_MESSAGES = 40;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 200 * 1024;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript))/;

const DelegateInput = z.object({ bot: z.string().min(1).max(64), task: z.string().min(1).max(20_000) });

/** Bot ids mentioned as @Name in the text (longest names first, so "@Ann Lee" beats "@Ann"). */
export function mentionedBots(text: string, bots: Pick<Bot, 'id' | 'name'>[]): string[] {
  const lower = text.toLocaleLowerCase();
  const found: string[] = [];
  const taken: [number, number][] = [];
  for (const b of [...bots].sort((x, y) => y.name.length - x.name.length)) {
    const needle = `@${b.name.toLocaleLowerCase()}`;
    let from = 0;
    for (;;) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      const end = i + needle.length;
      const after = lower[end];
      const overlaps = taken.some(([s, e]) => i < e && end > s);
      if (!overlaps && (after === undefined || !/[\p{L}\p{N}_]/u.test(after))) {
        taken.push([i, end]);
        if (!found.includes(b.id)) found.push(b.id);
        break;
      }
      from = i + 1;
    }
  }
  return found;
}

function defaultModel(kind: string): string | null {
  if (kind === 'anthropic') return ANTHROPIC_DEFAULT_MODEL;
  if (kind === 'claude-subscription' || kind === 'chatgpt-subscription') return 'default';
  return null;
}

function errorCode(e: unknown): string {
  if (e instanceof ProviderError) return e.code;
  if (e instanceof HttpError) return e.code;
  if ((e as Error)?.name === 'AbortError' || (e as Error)?.message === 'aborted') return 'stopped';
  return 'failed';
}

interface RunOpts {
  hop: number;
  depth: number;
  signal?: AbortSignal;
}

export class ChatRuntime {
  private running = new Map<string, { userId: string; ac: AbortController }>();
  private pending = new Set<Promise<unknown>>();

  constructor(private ctx: AppContext, private s: ChatServices) {}

  /** Posts the user's message and starts the replies. Retrying with the same clientId is a no-op. */
  send(user: User, convId: string, req: { text: string; parentId?: string | null; attachmentIds?: string[]; clientId: string }): Message {
    const { store } = this.s;
    store.ownedConv(user, convId);
    const existing = store.findByClientId(convId, req.clientId);
    if (existing) return store.toMessage(existing, user.id);
    const parentId = req.parentId ?? null;
    if (parentId) {
      const p = store.msgRow(parentId);
      // Threads are one level deep: replies hang off a top-level message of this chat.
      if (!p || p.conversation_id !== convId || p.parent_id) throw new HttpError(400, 'invalid_parent');
    }
    const attachmentIds = [...new Set(req.attachmentIds ?? [])];
    for (const a of attachmentIds) store.ownedAttachment(user, a);
    if (!req.text.trim() && attachmentIds.length === 0) throw new HttpError(400, 'empty_message');
    const bots = store.botIds(convId).map((id) => this.s.bots.get(id)!).filter(Boolean);
    const mentions = mentionedBots(req.text, bots);
    const row = store.insertMessage({ convId, author: 'user', userId: user.id, text: req.text, mentions, parentId, clientId: req.clientId, attachmentIds });
    this.s.search.put(user.id, row);
    store.markRead(user, convId);
    const msg = store.toMessage(row, user.id);
    this.ctx.bus.publish(user.id, CHAT_EVENTS.messageCreated, msg);
    this.publishConversation(user, convId);

    for (const bot of this.responders(convId, bots, mentions)) this.track(this.respond(user, bot, convId, parentId, { hop: 0, depth: 0 }));
    return msg;
  }

  /** In a direct chat the Bot answers; in a group the mentioned Bots, else the primary or first Bot. */
  private responders(convId: string, bots: Bot[], mentions: string[]): Bot[] {
    if (this.s.store.kind(convId) === 'direct') return bots.slice(0, 1);
    if (mentions.length) return bots.filter((b) => mentions.includes(b.id));
    return bots.slice(0, 1); // botIds() lists the primary Bot first
  }

  stop(user: User, msgId: string): void {
    const r = this.running.get(msgId);
    if (!r || r.userId !== user.id) throw new HttpError(404, 'not_running');
    r.ac.abort();
  }

  /** Waits for all replies in flight (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  abortAll(): void {
    for (const r of this.running.values()) r.ac.abort();
  }

  private track(p: Promise<unknown>): void {
    const q = p.catch((e) => this.ctx.log.error({ err: (e as Error).message }, 'reply failed'));
    this.pending.add(q);
    void q.finally(() => this.pending.delete(q));
  }

  private publishConversation(user: User, convId: string): void {
    this.ctx.bus.publish(user.id, CHAT_EVENTS.conversationUpdated, this.s.store.getConversation(user, convId));
  }

  /** Runs one Bot's reply in a chat; returns its final text (for delegation). */
  async respond(user: User, bot: Bot, convId: string, parentId: string | null, o: RunOpts): Promise<{ text: string; ok: boolean }> {
    const { store } = this.s;
    const placeholder = store.insertMessage({ convId, author: 'bot', botId: bot.id, text: '', parentId, status: 'streaming' });
    this.ctx.bus.publish(user.id, CHAT_EVENTS.messageCreated, store.toMessage(placeholder, user.id));
    const ac = new AbortController();
    const signal = o.signal ? AbortSignal.any([o.signal, ac.signal]) : ac.signal;
    this.running.set(placeholder.id, { userId: user.id, ac });
    let text = '';
    const emit = (t: string) => {
      text += t;
      this.ctx.bus.publish(user.id, CHAT_EVENTS.messageDelta, { id: placeholder.id, conversationId: convId, text: t });
    };
    let final: MsgRow;
    try {
      await this.runModel(user, bot, convId, parentId, placeholder.id, o, signal, emit);
      if (!text.trim()) throw new ProviderError('failed', 'empty reply');
      final = store.finishMessage(placeholder.id, text, 'done');
    } catch (e) {
      const code = signal.aborted ? 'stopped' : errorCode(e);
      final = store.finishMessage(placeholder.id, text, 'error', code);
      if (code !== 'stopped') {
        this.ctx.log.warn({ bot: bot.id, code }, 'bot reply failed');
        this.s.activity.log(user.id, bot.id, 'reply.error', { bot: bot.name, code });
      }
    } finally {
      this.running.delete(placeholder.id);
    }
    this.s.search.put(user.id, final);
    this.ctx.bus.publish(user.id, CHAT_EVENTS.messageDone, store.toMessage(final, user.id));
    this.publishConversation(user, convId);
    if (final.status !== 'done') return { text, ok: false };

    this.s.library.fromReply(user.id, bot.id, convId, final.id, text, store.attachmentsOf(final.id));
    if (bot.notify === 'all') void this.s.push.wake(user.id, final.id);

    // Group hand-off: Bots this reply mentions take the next turn (FR-BOT-03).
    if (store.kind(convId) === 'group' && o.hop < MAX_HANDOFF_HOPS) {
      const others = store.botIds(convId).filter((id) => id !== bot.id).map((id) => this.s.bots.get(id)!).filter(Boolean);
      const next = mentionedBots(text, others);
      if (next.length) {
        const body = store.body(final);
        this.ctx.db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(this.ctx.crypto.sealContent(JSON.stringify({ ...body, mentions: next }), `msg:${final.id}`), final.id);
        for (const id of next) {
          const target = others.find((b) => b.id === id)!;
          this.s.activity.log(user.id, bot.id, 'handoff', { bot: bot.name, target: target.name });
          this.track(this.respond(user, target, convId, parentId, { hop: o.hop + 1, depth: o.depth, signal: o.signal }));
        }
      }
    }
    return { text, ok: true };
  }

  private async runModel(user: User, bot: Bot, convId: string, parentId: string | null, selfId: string, o: RunOpts, signal: AbortSignal, emit: (t: string) => void): Promise<void> {
    if (!bot.sourceId) throw new HttpError(409, 'no_model_source');
    const { provider, kind } = this.s.sources.provider(user, bot.id, bot.sourceId);
    const model = bot.model || defaultModel(kind) || (await this.firstModel(provider, signal));
    const messages = this.context(user, bot, convId, parentId, selfId);
    if (!messages.length) throw new HttpError(409, 'nothing_to_answer');
    const delegates = bot.tools.includes('delegate') && o.depth < MAX_DELEGATION_DEPTH ? this.s.bots.list(user).filter((b) => b.id !== bot.id) : [];
    const tools: ToolSpec[] = delegates.length
      ? [{
          name: 'delegate',
          description: `Hand a task to another of the user's Bots and get its answer back. Available Bots: ${delegates.map((b) => b.name).join(', ')}.`,
          parameters: {
            type: 'object',
            properties: {
              bot: { type: 'string', description: 'Name of the Bot to hand the task to.' },
              task: { type: 'string', description: 'The complete task, with every detail the Bot needs.' },
            },
            required: ['bot', 'task'],
            additionalProperties: false,
          },
        }]
      : [];
    const system = this.system(user, bot, convId, delegates);

    let wrote = false;
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      let done: Extract<StreamEvent, { type: 'done' }> | null = null;
      let turnText = '';
      for await (const ev of provider.stream({ model, system, messages, tools, signal })) {
        if (ev.type === 'text') {
          // Text from an earlier tool turn and this one are separated by a blank line.
          if (!turnText && wrote) emit('\n\n');
          wrote = true;
          turnText += ev.text;
          emit(ev.text);
        } else done = ev;
      }
      if (!done) throw new ProviderError('failed', 'the stream ended early');
      if (done.usage) this.s.usage.record(user.id, bot.id, bot.sourceId, kind, model, done.usage);
      if (done.stop === 'refusal' && !turnText) throw new ProviderError('failed', 'refused');
      if (done.stop !== 'tool_use' || done.toolCalls.length === 0) return;
      messages.push({ role: 'assistant', text: done.text, toolCalls: done.toolCalls, native: done.native });
      for (const call of done.toolCalls) messages.push(await this.runTool(user, bot, call, delegates, o, signal));
    }
    throw new ProviderError('failed', 'too many tool turns');
  }

  private async firstModel(provider: ModelProvider, signal: AbortSignal): Promise<string> {
    const models = await provider.listModels(signal).catch(() => [] as string[]);
    if (!models[0]) throw new HttpError(409, 'no_model');
    return models[0];
  }

  private async runTool(user: User, bot: Bot, call: ToolCall, delegates: Bot[], o: RunOpts, signal: AbortSignal): Promise<ModelMessage> {
    const fail = (content: string): ModelMessage => ({ role: 'tool', toolCallId: call.id, content, isError: true });
    if (call.name !== 'delegate') return fail(`Unknown tool ${call.name}.`);
    const p = DelegateInput.safeParse(call.input);
    if (!p.success) return fail('Invalid input: give "bot" (a Bot name) and "task".');
    const want = p.data.bot.replace(/^@/, '').trim().toLocaleLowerCase();
    const target = delegates.find((b) => b.id === p.data.bot || b.name.toLocaleLowerCase() === want);
    if (!target) return fail(`No Bot named "${p.data.bot}". Available: ${delegates.map((b) => b.name).join(', ')}.`);
    // The hand-off is visible in the target Bot's own chat (FR-BOT-02).
    const conv = this.s.store.direct(user, target.id, target.name);
    const task = this.s.store.insertMessage({ convId: conv, author: 'system', text: `${bot.name}: ${p.data.task}` });
    this.s.search.put(user.id, task);
    this.ctx.bus.publish(user.id, CHAT_EVENTS.messageCreated, this.s.store.toMessage(task, user.id));
    this.s.activity.log(user.id, bot.id, 'delegate', { bot: bot.name, target: target.name });
    const r = await this.respond(user, target, conv, null, { hop: 0, depth: o.depth + 1, signal });
    if (!r.ok) return fail(`${target.name} could not finish the task.`);
    return { role: 'tool', toolCallId: call.id, content: r.text.slice(0, 50_000) };
  }

  private system(user: User, bot: Bot, convId: string, delegates: Bot[]): string {
    const parts = [bot.instructions.trim()];
    parts.push(`You are "${bot.name}", one of ${user.name}'s Bots. Today is ${new Date().toISOString().slice(0, 10)}. Write replies in Markdown.`);
    if (this.s.store.kind(convId) === 'group') {
      const others = this.s.store.botIds(convId).filter((id) => id !== bot.id).map((id) => this.s.bots.get(id)?.name).filter(Boolean);
      if (others.length) {
        parts.push(
          `This is a group chat with ${user.name} and these Bots: ${others.join(', ')}. Messages from other Bots start with their name in brackets. ` +
            'To hand work to another Bot, mention it as @Name in your reply. Mention a Bot only when you want it to act.',
        );
      }
    }
    if (delegates.length) parts.push(`You can hand tasks to these Bots with the delegate tool: ${delegates.map((b) => b.name).join(', ')}.`);
    return parts.filter(Boolean).join('\n\n');
  }

  /** The conversation as model messages: this Bot's replies are the assistant side. */
  private context(user: User, bot: Bot, convId: string, parentId: string | null, selfId: string): ModelMessage[] {
    const rows = this.s.store.contextRows(convId, parentId, CONTEXT_MESSAGES).filter((r) => r.id !== selfId && r.status === 'done');
    const out: ModelMessage[] = [];
    for (const r of rows) {
      const text = this.s.store.body(r).text;
      if (r.author === 'bot' && r.bot_id === bot.id) {
        const last = out[out.length - 1];
        if (last?.role === 'assistant') last.text += `\n\n${text}`;
        else out.push({ role: 'assistant', text });
        continue;
      }
      let label = '';
      if (r.author === 'bot') label = `[${this.s.bots.get(r.bot_id ?? '')?.name ?? this.botName(r.bot_id)}] `;
      else if (r.author === 'system') label = '[Task] ';
      const parts: UserPart[] = [];
      if (text) parts.push({ type: 'text', text: label + text });
      if (r.author === 'user') parts.push(...this.attachmentParts(r.id));
      if (!parts.length) continue;
      const last = out[out.length - 1];
      if (last?.role === 'user') last.content.push(...parts);
      else out.push({ role: 'user', content: parts });
    }
    while (out[0] && out[0].role !== 'user') out.shift();
    return out;
  }

  private botName(id: string | null): string {
    if (!id) return 'Bot';
    const r = this.ctx.db.prepare('SELECT name FROM bots WHERE id = ?').get(id) as { name: string } | undefined;
    return r?.name ?? 'Bot';
  }

  private attachmentParts(msgId: string): UserPart[] {
    const parts: UserPart[] = [];
    for (const a of this.s.store.attachmentsOf(msgId)) {
      if (IMAGE_MIMES.has(a.mime) && a.size <= MAX_IMAGE_BYTES) {
        parts.push({ type: 'image', mime: a.mime, dataB64: Buffer.from(this.s.store.readAttachment(a.id)).toString('base64') });
      } else if (TEXT_MIME.test(a.mime) && a.size <= MAX_TEXT_FILE_BYTES) {
        const body = Buffer.from(this.s.store.readAttachment(a.id)).toString('utf8');
        parts.push({ type: 'text', text: `Attached file "${a.name}":\n\`\`\`\n${body}\n\`\`\`` });
      } else {
        parts.push({ type: 'text', text: `[Attached file "${a.name}" (${a.mime}, ${a.size} bytes) is not readable as text]` });
      }
    }
    return parts;
  }
}
