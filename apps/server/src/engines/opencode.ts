// OpenCode adapter (D-08, MIT): `opencode run --format json`, resumed with `--session <id>`.
// Works with local and any API model source. The provider is configured through
// OPENCODE_CONFIG_CONTENT; the key is referenced as {env:ADVENCE_MODEL_KEY}, never written out.
import type { EngineStep, ModelSourceKind } from '@advence/protocol';
import { clip, EngineError, hostRun, TurnSession, type CodingEngine, type EngineEvent, type EngineStart } from './types.js';

const MAX_PROMPT = 100_000;

export function opencodeConfig(o: EngineStart): { config: Record<string, unknown>; model: string } {
  const a = o.auth;
  const model = a.model && a.model !== 'default' ? a.model : '';
  const key = '{env:ADVENCE_MODEL_KEY}';
  let provider: string;
  let providerCfg: Record<string, unknown>;
  if (a.kind === 'anthropic') {
    provider = 'anthropic';
    providerCfg = { options: { apiKey: key, ...(o.anthropicBaseUrl ? { baseURL: `${o.anthropicBaseUrl.replace(/\/+$/, '')}/v1` } : {}) } };
  } else if (a.kind === 'openai' && !a.baseUrl) {
    provider = 'openai';
    providerCfg = { options: { apiKey: key } };
  } else {
    provider = 'advence';
    providerCfg = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Advence',
      options: { baseURL: (a.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, ''), apiKey: key },
      models: { [model || 'default']: { name: model || 'default' } },
    };
  }
  return {
    model: `${provider}/${model || (provider === 'anthropic' ? 'claude-sonnet-5-5' : provider === 'openai' ? 'gpt-5' : 'default')}`,
    config: {
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      // The Bot's container is the sandbox (D-09, NFR-SEC-08); inside it the engine acts freely.
      permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
      provider: { [provider]: providerCfg },
    },
  };
}

class OpenCodeSession extends TurnSession {
  readonly engine = 'opencode' as const;

  protected launch(prompt: string, signal: AbortSignal) {
    const { config, model } = opencodeConfig(this.o);
    const env = { ADVENCE_MODEL_KEY: this.o.auth.secret || 'none', OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
    const argv = ['opencode', 'run', '--format', 'json', '-m', model, ...(this.sessionId ? ['--session', this.sessionId] : []), '--', prompt.slice(0, MAX_PROMPT)];
    return hostRun(this.o, argv, '', env, signal);
  }

  protected parse(j: any): EngineEvent[] {
    const out: EngineEvent[] = [];
    if (typeof j?.sessionID === 'string' && j.sessionID !== this.sessionId) out.push({ type: 'session', id: j.sessionID });
    const part = j?.part ?? {};
    switch (j?.type) {
      case 'text':
        if (part.text) out.push({ type: 'text', text: (this.text ? '\n\n' : '') + String(part.text) });
        break;
      case 'tool_use': {
        const st = part.state ?? {};
        const input = (st.input ?? {}) as Record<string, any>;
        const status: EngineStep['status'] = st.status === 'error' ? 'failed' : st.status === 'completed' ? 'done' : 'running';
        const id = String(part.callID ?? part.id);
        if (part.tool === 'bash') {
          const exit = typeof st.metadata?.exit === 'number' ? st.metadata.exit : null;
          out.push({ type: 'step', step: { id, kind: 'command', title: String(input.command ?? ''), body: clip(String(st.output ?? st.error ?? '')), status: exit !== null && exit !== 0 ? 'failed' : status, exitCode: exit } });
        } else if (part.tool === 'edit' || part.tool === 'write' || part.tool === 'patch' || part.tool === 'multiedit') {
          const diff = typeof st.metadata?.diff === 'string' ? st.metadata.diff : part.tool === 'write' ? String(input.content ?? '').split('\n').map((l) => `+${l}`).join('\n') : `-${String(input.oldString ?? '')}\n+${String(input.newString ?? '')}`;
          out.push({ type: 'step', step: { id, kind: 'diff', title: String(input.filePath ?? input.path ?? part.tool), body: clip(diff), status, exitCode: null } });
        } else if (part.tool === 'todowrite') {
          out.push({ type: 'step', step: { id, kind: 'plan', title: 'Plan', body: ((input.todos ?? []) as { content: string; status: string }[]).map((t) => `${t.status === 'completed' ? '[x]' : '[ ]'} ${t.content}`).join('\n'), status: 'done', exitCode: null } });
        } else {
          out.push({ type: 'step', step: { id, kind: 'tool', title: String(part.tool ?? 'tool'), body: clip(String(st.output ?? JSON.stringify(input)), 2000), status, exitCode: null } });
        }
        break;
      }
      case 'step_finish': {
        const t = part.tokens ?? {};
        out.push({ type: 'usage', usage: { inputTokens: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0), outputTokens: (t.output ?? 0) + (t.reasoning ?? 0), costUsd: typeof part.cost === 'number' && part.cost > 0 ? part.cost : null } });
        break;
      }
      case 'error':
        this.error = 'engine_failed';
        break;
    }
    return out;
  }
}

const SUPPORTED: ModelSourceKind[] = ['openai', 'openai-compatible', 'local', 'anthropic'];
export const opencodeEngine: CodingEngine = {
  id: 'opencode',
  supports: (k) => SUPPORTED.includes(k),
  start(o: EngineStart) {
    if (!this.supports(o.auth.kind)) throw new EngineError('engine_source_mismatch', 'OpenCode needs a local or API key model source');
    return new OpenCodeSession(o, null);
  },
  resume(id: string, o: EngineStart) {
    if (!this.supports(o.auth.kind)) throw new EngineError('engine_source_mismatch', 'OpenCode needs a local or API key model source');
    return new OpenCodeSession(o, id);
  },
};
