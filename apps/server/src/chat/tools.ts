// Bot tools added in P3: `code` runs the Bot's coding engine in its computer (FR-CODE-01..05),
// `computer` sees and uses the Bot's own desktop (FR-PC-01, FR-UI-05), and `host` controls the
// server's desktop when the owner turned Host control on (D-12, FR-PC-09).
import { z } from 'zod';
import { COMPUTER_EVENTS, type Bot, type EngineStep, type User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';
import type { ModelMessage, ToolCall, ToolSpec } from '../models/types.js';
import type { ModelSources } from '../models/sources.js';
import { ENGINES, ENGINE_PACKAGES, EngineError, type EngineSession } from '../engines/index.js';
import { actionResult, DesktopAction, desktopToolSpec, hostAction, x11Script, type ActionResult } from '../computer/actions.js';
import type { ComputerManager } from '../computer/manager.js';
import type { ChatStore } from './store.js';
import type { UsageLog } from './usage.js';
import type { Activity } from './activity.js';
import type { ToolProvider, ToolTraits } from './runtime.js';

const CodeInput = z.object({ task: z.string().min(1).max(100_000) });
export const WORKSPACE = '/home/bot/workspace';
const STEP_PUBLISH_MS = 300;

/** Checks for the engine in the Bot's home volume and installs it from npm if missing (C-06). */
function installScript(engine: Bot['engine']): string {
  const pkg = ENGINE_PACKAGES[engine];
  const probe = engine === 'claude-agent-sdk'
    ? 'test -e "${ADVENCE_CLAUDE_SDK:-$HOME/.local/lib/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs}"'
    : `command -v ${engine === 'codex' ? 'codex' : 'opencode'} >/dev/null 2>&1`;
  return `${probe} || bot-computer-install-engines ${pkg} >&2`;
}

export interface ToolDeps {
  sources: ModelSources;
  store: ChatStore;
  usage: UsageLog;
  activity: Activity;
  /** null when this server runs CLIs without containers (tests) */
  computers: ComputerManager | null;
  /** whether commands need the Bot's computer running first (the Podman host) */
  needsComputer: boolean;
}

interface CallCtx { user: User; bot: Bot; convId: string; messageId: string; signal: AbortSignal }

export class BotTools implements ToolProvider {
  constructor(private ctx: AppContext, private d: ToolDeps) {}

  specs(user: User, bot: Bot): ToolSpec[] {
    const out: ToolSpec[] = [];
    if (bot.tools.includes('code')) {
      out.push({
        name: 'code',
        description:
          `Run a software task with your coding engine (${bot.engine}) inside your own computer, in ${WORKSPACE}. ` +
          'The engine edits files, runs commands and tests, uses git and iterates until the task is done; it keeps its session across calls in this chat. ' +
          'Give the complete task with every detail. You get back the engine\'s final report.',
        parameters: { type: 'object', properties: { task: { type: 'string', description: 'The complete coding task.' } }, required: ['task'], additionalProperties: false },
      });
    }
    if (bot.tools.includes('computer')) out.push(desktopToolSpec('computer', 'See and use your own computer\'s desktop (Xfce with Chromium). The owner may be watching it live.'));
    // Host control is an owner-only toggle per Bot, off by default (D-12).
    if (bot.tools.includes('host') && bot.hostControl && user.role === 'owner') out.push(desktopToolSpec('host', 'Control the desktop of the computer the server runs on (Host control is on for you).'));
    return out;
  }

  handles(name: string): boolean {
    return name === 'code' || name === 'computer' || name === 'host';
  }

  /** Work surfaces: what the engine and the screens show is work content (repositories, web pages). */
  traits(): ToolTraits {
    return { readOnly: false, taint: 'work', work: true };
  }

  async run(c: CallCtx, call: ToolCall): Promise<ModelMessage> {
    const fail = (content: string): ModelMessage => ({ role: 'tool', toolCallId: call.id, content, isError: true });
    const allowed = this.specs(c.user, c.bot).some((s) => s.name === call.name);
    if (!allowed) return fail(call.name === 'host' ? 'Host control is off for this Bot.' : `The ${call.name} tool is not enabled for this Bot.`);
    try {
      if (call.name === 'code') {
        const p = CodeInput.safeParse(call.input);
        if (!p.success) return fail('Invalid input: give "task".');
        return { role: 'tool', toolCallId: call.id, ...(await this.code(c, p.data.task)) };
      }
      const a = DesktopAction.safeParse(call.input);
      if (!a.success) return fail(`Invalid action: ${a.error.issues[0]?.message ?? 'see the tool description'}.`);
      const r = call.name === 'computer' ? await this.computer(c, a.data) : await this.host(c, a.data);
      return { role: 'tool', toolCallId: call.id, content: r.text, ...(r.images ? { images: r.images } : {}), ...(r.isError ? { isError: true } : {}) };
    } catch (e) {
      if (c.signal.aborted) throw e;
      const code = e instanceof HttpError || e instanceof EngineError ? e.code : 'failed';
      this.ctx.log.warn({ bot: c.bot.id, tool: call.name, code }, 'tool failed');
      return fail(TOOL_ERRORS[code] ?? `The ${call.name} tool failed (${code}).`);
    }
  }

  // ------------------------------------------------------------------ computer (the Bot's own)
  private async computer(c: CallCtx, a: DesktopAction): Promise<ActionResult> {
    const m = this.d.computers;
    if (!m) return { text: 'This server has no Bot computers.', isError: true };
    await m.ensure({ id: c.bot.id, userId: c.user.id });
    // The owner has the mouse and keyboard: wait until they hand back (FR-UI-05).
    await m.whenFree(c.bot.id, c.signal);
    const { script, env } = x11Script(a);
    const run = m.exec(c.bot.id, ['sh', '-c', script], { env: { DISPLAY: ':1', ...env }, signal: c.signal });
    let out = '';
    for await (const l of run.lines) out += l;
    const { code, stderr } = await run.done;
    this.d.activity.log(c.user.id, c.bot.id, 'computer.action', { bot: c.bot.name, action: a.action });
    return actionResult(a, code, out, stderr);
  }

  // ------------------------------------------------------------------ host control (D-12)
  private async host(c: CallCtx, a: DesktopAction): Promise<ActionResult> {
    this.d.activity.log(c.user.id, c.bot.id, 'host.action', { bot: c.bot.name, action: a.action });
    return hostAction(a, c.signal);
  }

  // ------------------------------------------------------------------ coding engine (FR-CODE-*)
  private async code(c: CallCtx, task: string): Promise<{ content: string; isError?: boolean }> {
    const { bot, user } = c;
    if (!bot.sourceId) throw new HttpError(409, 'no_model_source');
    const cred = this.d.sources.credentials(user, bot.sourceId);
    const engine = ENGINES[bot.engine];
    if (!engine.supports(cred.kind)) throw new EngineError('engine_source_mismatch', 'mismatch');
    if (this.d.needsComputer) {
      if (!this.d.computers) throw new HttpError(503, 'computer_unavailable');
      await this.d.computers.ensure({ id: bot.id, userId: user.id });
    }
    // Install the engine on first use (from its official registry, C-06).
    const inst = this.ctx.processHost.run({ botId: bot.id, argv: ['sh', '-c', installScript(bot.engine)], stdin: '', env: {}, signal: c.signal });
    for await (const _ of inst.lines) void _;
    if ((await inst.done).code !== 0) throw new EngineError('engine_missing', 'install failed');

    const start = {
      host: this.ctx.processHost, botId: bot.id, cwd: WORKSPACE, signal: c.signal,
      auth: { kind: cred.kind, baseUrl: cred.baseUrl, secret: cred.secret ?? '', model: bot.model || null },
      anthropicBaseUrl: this.ctx.testHooks?.anthropicBaseUrl,
    };
    const saved = this.sessionOf(bot.id, c.convId, bot.engine);
    const session: EngineSession = saved ? engine.resume(saved, start) : engine.start(start);
    this.d.activity.log(user.id, bot.id, 'code.started', { bot: bot.name, engine: bot.engine });

    const steps = new Map<string, EngineStep>();
    for (const s of this.d.store.steps(this.d.store.msgRow(c.messageId)!)) steps.set(s.id, s);
    let last = 0;
    let timer: NodeJS.Timeout | null = null;
    const publish = () => {
      timer = null;
      last = Date.now();
      const list = [...steps.values()];
      this.d.store.setSteps(c.messageId, list);
      this.ctx.bus.publish(user.id, COMPUTER_EVENTS.messageSteps, { id: c.messageId, conversationId: c.convId, steps: list });
    };
    const schedule = () => {
      if (timer) return;
      const wait = Math.max(0, STEP_PUBLISH_MS - (Date.now() - last));
      timer = setTimeout(publish, wait);
    };

    session.send(task);
    let result = { ok: false, text: '', error: 'engine_failed' as string | null };
    try {
      for await (const ev of session.stream()) {
        if (ev.type === 'step') {
          steps.set(ev.step.id, ev.step);
          schedule();
        } else if (ev.type === 'session') this.saveSession(bot.id, c.convId, bot.engine, ev.id);
        else if (ev.type === 'usage') this.d.usage.record(user.id, bot.id, bot.sourceId, cred.kind, bot.model || bot.engine, ev.usage);
        else if (ev.type === 'done') result = ev;
      }
    } finally {
      if (timer) clearTimeout(timer);
      // Anything still marked running when the engine stopped did not finish.
      for (const s of steps.values()) if (s.status === 'running') s.status = 'failed';
      publish();
    }
    this.d.activity.log(user.id, bot.id, result.ok ? 'code.done' : 'code.failed', { bot: bot.name, engine: bot.engine, steps: String(steps.size) });
    if (!result.ok) {
      if (result.error === 'stopped' || c.signal.aborted) throw new Error('aborted');
      return { content: `The coding engine stopped with an error (${result.error}).${result.text ? `\n\nIts last output:\n${result.text.slice(-4000)}` : ''}`, isError: true };
    }
    return { content: (result.text || 'The engine finished without a report.').slice(0, 50_000) };
  }

  private sessionOf(botId: string, convId: string, engine: string): string | null {
    const r = this.ctx.db.prepare('SELECT session FROM engine_sessions WHERE bot_id = ? AND conversation_id = ? AND engine = ?').get(botId, convId, engine) as { session: Buffer } | undefined;
    return r ? this.ctx.crypto.openContent(r.session, `eng:${botId}:${convId}`) : null;
  }

  private saveSession(botId: string, convId: string, engine: string, id: string): void {
    this.ctx.db
      .prepare('INSERT INTO engine_sessions(bot_id, conversation_id, engine, session, updated_at) VALUES(?,?,?,?,?) ON CONFLICT(bot_id, conversation_id, engine) DO UPDATE SET session = excluded.session, updated_at = excluded.updated_at')
      .run(botId, convId, engine, this.ctx.crypto.sealContent(id, `eng:${botId}:${convId}`), Date.now());
  }
}

const TOOL_ERRORS: Record<string, string> = {
  no_model_source: 'This Bot has no model source.',
  engine_source_mismatch: 'This Bot\'s coding engine cannot use its model source. The owner can change the engine or the source in the Bot\'s profile.',
  engine_missing: 'The coding engine could not be installed in the Bot\'s computer.',
  computer_unavailable: 'The Bot\'s computer is not available on this server (no container runtime).',
  computer_start_failed: 'The Bot\'s computer could not start.',
  image_build_failed: 'The Bot computer image could not be built.',
  disk_full: 'The Bot\'s computer is over its disk limit.',
  model_source_missing: 'This Bot\'s model source was removed.',
  owner_only: 'Only the server owner can use this model source.',
};
