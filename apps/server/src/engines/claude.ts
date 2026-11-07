// Claude Agent SDK adapter (D-08). The SDK is installed in the Bot's home volume from npm on first
// start (C-06, never bundled); a small runner of ours drives `query()` and prints its messages as
// JSONL. API key: ANTHROPIC_API_KEY; Claude subscription (owner only, D-07c): the token from
// `claude setup-token` as CLAUDE_CODE_OAUTH_TOKEN.
import type { EngineStep, ModelSourceKind } from '@advence/protocol';
import { CLIP, clip, EngineError, hostRun, TurnSession, type CodingEngine, type EngineEvent, type EngineStart } from './types.js';

/** Runs inside the Bot's computer: `node --input-type=module -e RUNNER` with the request on stdin. */
export const CLAUDE_RUNNER = `
import { pathToFileURL } from 'node:url';
let raw = '';
for await (const c of process.stdin) raw += c;
const req = JSON.parse(raw);
const sdk = process.env.ADVENCE_CLAUDE_SDK || (process.env.HOME + '/.local/lib/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs');
const { query } = await import(pathToFileURL(sdk).href);
const q = query({ prompt: req.prompt, options: {
  cwd: process.cwd(),
  model: req.model || undefined,
  resume: req.resume || undefined,
  // The Bot's container is the sandbox (D-09, NFR-SEC-08); inside it the engine acts freely.
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  settingSources: ['project'],
} });
for await (const m of q) process.stdout.write(JSON.stringify(m) + '\\n');
`;

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** A small unified-style diff of an edit tool call, for the chat view (FR-CODE-04). */
export function editDiff(name: string, input: Record<string, any>): string {
  const lines = (s: unknown, sign: string) => String(s ?? '').split('\n').map((l) => `${sign}${l}`).join('\n');
  if (name === 'Write') return lines(input.content, '+');
  if (name === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.map((e: any) => `${lines(e.old_string, '-')}\n${lines(e.new_string, '+')}`).join('\n@@\n');
  if (name === 'NotebookEdit') return lines(input.new_source, '+');
  return `${lines(input.old_string, '-')}\n${lines(input.new_string, '+')}`;
}

class ClaudeSession extends TurnSession {
  readonly engine = 'claude-agent-sdk' as const;
  private steps = new Map<string, EngineStep>();

  protected launch(prompt: string, signal: AbortSignal) {
    const a = this.o.auth;
    const env: Record<string, string> = a.kind === 'claude-subscription' ? { CLAUDE_CODE_OAUTH_TOKEN: a.secret } : { ANTHROPIC_API_KEY: a.secret };
    if (this.o.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = this.o.anthropicBaseUrl;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    const stdin = JSON.stringify({ prompt, model: a.model && a.model !== 'default' ? a.model : null, resume: this.sessionId });
    return hostRun(this.o, ['node', '--input-type=module', '-e', CLAUDE_RUNNER], stdin, env, signal);
  }

  protected parse(j: any): EngineEvent[] {
    const out: EngineEvent[] = [];
    if (j?.session_id && j.session_id !== this.sessionId && (j.type === 'system' || j.type === 'assistant' || j.type === 'result')) out.push({ type: 'session', id: j.session_id });
    if (j?.type === 'assistant' && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b.type === 'text' && b.text) out.push({ type: 'text', text: (this.text ? '\n\n' : '') + b.text });
        else if (b.type === 'tool_use') {
          const input = (b.input ?? {}) as Record<string, any>;
          let step: EngineStep;
          if (b.name === 'Bash') step = { id: b.id, kind: 'command', title: String(input.command ?? ''), body: '', status: 'running', exitCode: null };
          else if (EDIT_TOOLS.has(b.name)) step = { id: b.id, kind: 'diff', title: String(input.file_path ?? input.notebook_path ?? b.name), body: clip(editDiff(b.name, input)), status: 'running', exitCode: null };
          else if (b.name === 'TodoWrite') step = { id: b.id, kind: 'plan', title: 'Plan', body: (input.todos ?? []).map((t: any) => `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.content}`).join('\n'), status: 'done', exitCode: null };
          else step = { id: b.id, kind: 'tool', title: b.name === 'Task' || b.name === 'Agent' ? `${b.name}: ${input.description ?? ''}` : b.name, body: clip(JSON.stringify(input), 2000), status: 'running', exitCode: null };
          this.steps.set(b.id, step);
          out.push({ type: 'step', step: { ...step } });
        }
      }
    } else if (j?.type === 'user' && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (b.type !== 'tool_result') continue;
        const step = this.steps.get(b.tool_use_id);
        if (!step) continue;
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : '')).join('\n') : '';
        step.status = b.is_error ? 'failed' : 'done';
        if (step.kind === 'command' || step.kind === 'tool') step.body = clip(text, CLIP);
        const m = step.kind === 'command' ? /exit code (\d+)/i.exec(text) : null;
        step.exitCode = step.kind === 'command' ? (m ? Number(m[1]) : b.is_error ? 1 : 0) : null;
        out.push({ type: 'step', step: { ...step } });
      }
    } else if (j?.type === 'result') {
      const u = j.usage ?? {};
      out.push({
        type: 'usage',
        usage: {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
          costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
        },
      });
      if (j.is_error || j.subtype !== 'success') this.error = String(j.subtype === 'success' ? 'engine_failed' : j.subtype ?? 'engine_failed');
      if (!this.text && typeof j.result === 'string' && j.result) out.push({ type: 'text', text: j.result });
    }
    return out;
  }
}

export const claudeEngine: CodingEngine = {
  id: 'claude-agent-sdk',
  supports: (k: ModelSourceKind) => k === 'anthropic' || k === 'claude-subscription',
  start(o: EngineStart) {
    if (!this.supports(o.auth.kind)) throw new EngineError('engine_source_mismatch', 'the Claude Agent SDK needs an Anthropic key or a Claude subscription');
    return new ClaudeSession(o, null);
  },
  resume(id: string, o: EngineStart) {
    if (!this.supports(o.auth.kind)) throw new EngineError('engine_source_mismatch', 'the Claude Agent SDK needs an Anthropic key or a Claude subscription');
    return new ClaudeSession(o, id);
  },
};
