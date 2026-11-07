// OpenAI Codex CLI adapter (D-08): `codex exec --json`, resumed with `codex exec resume <id>`.
// OpenAI key: CODEX_API_KEY. ChatGPT subscription (owner only): the auth.json from the device
// login is written into the engine's home only for the length of the turn. Any other
// OpenAI-compatible source is configured as a custom provider (Responses API).
import type { EngineStep, ModelSourceKind } from '@advence/protocol';
import { clip, EngineError, hostRun, TurnSession, type CodingEngine, type EngineEvent, type EngineStart } from './types.js';

/** Shell wrapper: private CODEX_HOME in the Bot's volume; the ChatGPT sign-in only exists during the turn. */
const WRAP =
  'umask 077; export CODEX_HOME="$HOME/.advence/codex"; mkdir -p "$CODEX_HOME"; ' +
  'if [ -n "$ADVENCE_CODEX_AUTH" ]; then printf %s "$ADVENCE_CODEX_AUTH" > "$CODEX_HOME/auth.json"; fi; unset ADVENCE_CODEX_AUTH; ' +
  'codex "$@"; r=$?; rm -f "$CODEX_HOME/auth.json"; exit $r';

class CodexSession extends TurnSession {
  readonly engine = 'codex' as const;

  protected launch(prompt: string, signal: AbortSignal) {
    const a = this.o.auth;
    const env: Record<string, string> = {};
    const cfg: string[] = [];
    if (a.kind === 'chatgpt-subscription') env.ADVENCE_CODEX_AUTH = a.secret;
    else if (a.kind === 'openai' && !a.baseUrl) {
      env.CODEX_API_KEY = a.secret;
      env.OPENAI_API_KEY = a.secret;
    } else {
      env.ADVENCE_MODEL_KEY = a.secret || 'none';
      const base = (a.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
      cfg.push('-c', 'model_provider="advence"', '-c', `model_providers.advence={name="advence",base_url=${JSON.stringify(base)},env_key="ADVENCE_MODEL_KEY",wire_api="responses"}`);
    }
    const common = [
      '--json', '--skip-git-repo-check',
      // The Bot's container is the sandbox (D-09, NFR-SEC-08); inside it the engine acts freely.
      '--dangerously-bypass-approvals-and-sandbox',
      ...cfg,
      ...(a.model && a.model !== 'default' ? ['-m', a.model] : []),
    ];
    const args = this.sessionId ? ['exec', 'resume', this.sessionId, ...common, '-'] : ['exec', ...common, '-'];
    return hostRun(this.o, ['sh', '-c', WRAP, 'codex', ...args], prompt, env, signal);
  }

  protected parse(j: any): EngineEvent[] {
    const out: EngineEvent[] = [];
    switch (j?.type) {
      case 'thread.started':
        if (j.thread_id) out.push({ type: 'session', id: String(j.thread_id) });
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const it = j.item ?? {};
        const done = j.type === 'item.completed';
        if (it.type === 'agent_message' && done && it.text) out.push({ type: 'text', text: (this.text ? '\n\n' : '') + it.text });
        else if (it.type === 'command_execution') {
          const exit = typeof it.exit_code === 'number' ? it.exit_code : null;
          const step: EngineStep = { id: String(it.id), kind: 'command', title: String(it.command ?? ''), body: clip(String(it.aggregated_output ?? '')), status: done ? (exit === 0 ? 'done' : 'failed') : 'running', exitCode: exit };
          out.push({ type: 'step', step });
        } else if (it.type === 'file_change') {
          const changes = (it.changes ?? []) as { path: string; kind: string }[];
          out.push({ type: 'step', step: { id: String(it.id), kind: 'diff', title: changes.map((c) => c.path).join(', ') || 'files', body: changes.map((c) => `${c.kind} ${c.path}`).join('\n'), status: it.status === 'failed' ? 'failed' : done ? 'done' : 'running', exitCode: null } });
        } else if (it.type === 'todo_list') {
          out.push({ type: 'step', step: { id: String(it.id), kind: 'plan', title: 'Plan', body: ((it.items ?? []) as { text: string; completed: boolean }[]).map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n'), status: 'done', exitCode: null } });
        } else if (it.type === 'mcp_tool_call' || it.type === 'web_search') {
          out.push({ type: 'step', step: { id: String(it.id), kind: 'tool', title: it.type === 'web_search' ? `web search: ${it.query ?? ''}` : `${it.server ?? ''} ${it.tool ?? ''}`.trim(), body: '', status: done ? 'done' : 'running', exitCode: null } });
        }
        break;
      }
      case 'turn.completed': {
        const u = j.usage ?? {};
        out.push({ type: 'usage', usage: { inputTokens: (u.input_tokens ?? 0), outputTokens: (u.output_tokens ?? 0), costUsd: null } });
        break;
      }
      case 'turn.failed':
        this.error = /usage limit|rate/i.test(String(j.error?.message ?? '')) ? 'rate_limited' : 'engine_failed';
        break;
    }
    return out;
  }
}

const SUPPORTED: ModelSourceKind[] = ['openai', 'openai-compatible', 'local', 'chatgpt-subscription'];
export const codexEngine: CodingEngine = {
  id: 'codex',
  supports: (k) => SUPPORTED.includes(k),
  start(o: EngineStart) {
    if (!this.supports(o.auth.kind)) throw new EngineError('engine_source_mismatch', 'Codex needs an OpenAI-compatible source or a ChatGPT subscription');
    return new CodexSession(o, null);
  },
  resume(id: string, o: EngineStart) {
    if (!this.supports(o.auth.kind)) throw new EngineError('engine_source_mismatch', 'Codex needs an OpenAI-compatible source or a ChatGPT subscription');
    return new CodexSession(o, id);
  },
};
