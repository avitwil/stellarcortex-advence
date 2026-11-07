// Subscription model sources (D-07c, owner's personal use only): the official Claude Code
// CLI (Claude subscription) and the official Codex CLI (ChatGPT subscription), run inside the
// Bot's container. Chat turns run with the CLI's own tools turned off.
import type { ChatRequest, ModelProvider, StreamEvent, ModelMessage } from './types.js';
import { ProviderError } from './types.js';
import type { ProcessHost } from './host.js';

/** Renders the conversation as one prompt, since the CLIs take a single prompt per call. */
export function transcript(messages: ModelMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.content.map((p) => (p.type === 'text' ? p.text : '[image omitted]')).join('\n');
      parts.push(`User: ${text}`);
    } else if (m.role === 'assistant') parts.push(`Assistant: ${m.text}`);
    else parts.push(`Tool result: ${m.content}`);
  }
  if (messages.length === 1 && messages[0]!.role === 'user') return parts[0]!.slice('User: '.length);
  return `${parts.join('\n\n')}\n\nReply as the Assistant to the last User message.`;
}

function exitError(code: number, stderr: string): ProviderError {
  if (/not (logged|signed) in|login|unauthori[sz]ed|401|invalid.*token/i.test(stderr)) return new ProviderError('not_signed_in', 'the subscription is not signed in');
  if (/rate.?limit|usage limit|429/i.test(stderr)) return new ProviderError('rate_limited', 'the subscription usage limit was reached');
  return new ProviderError('failed', `the CLI exited with code ${code}`);
}

export class ClaudeCliProvider implements ModelProvider {
  constructor(private o: { host: ProcessHost; botId: string; token: string | undefined }) {}

  async listModels(): Promise<string[]> {
    return ['default', 'opus', 'sonnet', 'haiku'];
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.o.token) throw new ProviderError('not_signed_in', 'the Claude subscription is not signed in');
    const argv = [
      'claude', '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '',
      '--strict-mcp-config',
      ...(req.model && req.model !== 'default' ? ['--model', req.model] : []),
      ...(req.system ? ['--system-prompt', req.system] : []),
    ];
    const run = this.o.host.run({ botId: this.o.botId, argv, stdin: transcript(req.messages), env: { CLAUDE_CODE_OAUTH_TOKEN: this.o.token }, signal: req.signal });
    let text = '';
    let streamed = false;
    let usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null = null;
    let isError = false;
    for await (const line of run.lines) {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.type === 'stream_event' && j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta') {
        streamed = true;
        text += j.event.delta.text;
        yield { type: 'text', text: j.event.delta.text };
      } else if (j.type === 'assistant' && !streamed) {
        for (const b of j.message?.content ?? []) {
          if (b.type === 'text' && b.text) {
            text += b.text;
            yield { type: 'text', text: b.text };
          }
        }
      } else if (j.type === 'result') {
        isError = !!j.is_error;
        if (!text && typeof j.result === 'string' && !isError) {
          text = j.result;
          yield { type: 'text', text };
        }
        const u = j.usage ?? {};
        usage = {
          inputTokens: Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0),
          outputTokens: Number(u.output_tokens ?? 0),
          costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
        };
      }
    }
    const { code, stderr } = await run.done;
    if (req.signal.aborted) throw new Error('aborted');
    if (code !== 0 || isError) throw exitError(code, stderr + (isError ? ' error' : ''));
    yield { type: 'done', text, toolCalls: [], usage, stop: 'end' };
  }
}

export class CodexCliProvider implements ModelProvider {
  constructor(private o: { host: ProcessHost; botId: string; authJson: string | undefined }) {}

  async listModels(): Promise<string[]> {
    return ['default'];
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.o.authJson) throw new ProviderError('not_signed_in', 'the ChatGPT subscription is not signed in');
    // The CLI reads its sign-in from $CODEX_HOME/auth.json; a small wrapper writes it from the
    // environment into a private temp dir so it never lands in the Bot's volume.
    const prompt = (req.system ? `${req.system}\n\n` : '') + transcript(req.messages);
    const argv = [
      'sh', '-c',
      'umask 077; d=$(mktemp -d); printf %s "$ADVENCE_CODEX_AUTH" > "$d/auth.json"; unset ADVENCE_CODEX_AUTH; CODEX_HOME="$d" codex exec --json --skip-git-repo-check --sandbox read-only "$@" -; r=$?; rm -rf "$d"; exit $r',
      'codex-turn',
      ...(req.model && req.model !== 'default' ? ['--model', req.model] : []),
    ];
    const run = this.o.host.run({ botId: this.o.botId, argv, stdin: prompt, env: { ADVENCE_CODEX_AUTH: this.o.authJson }, signal: req.signal });
    let text = '';
    let usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null = null;
    for await (const line of run.lines) {
      let j: any;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.type === 'item.completed' && j.item?.type === 'agent_message' && typeof j.item.text === 'string') {
        const t = (text ? '\n\n' : '') + j.item.text;
        text += t;
        yield { type: 'text', text: t };
      } else if (j.type === 'turn.completed' && j.usage) {
        usage = { inputTokens: Number(j.usage.input_tokens ?? 0), outputTokens: Number(j.usage.output_tokens ?? 0), costUsd: null };
      } else if (j.type === 'turn.failed' || j.type === 'error') {
        throw exitError(1, String(j.error?.message ?? j.message ?? ''));
      }
    }
    const { code, stderr } = await run.done;
    if (req.signal.aborted) throw new Error('aborted');
    if (code !== 0) throw exitError(code, stderr);
    yield { type: 'done', text, toolCalls: [], usage, stop: 'end' };
  }
}
