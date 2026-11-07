// Anthropic Messages API through the official SDK (D-07 "own API keys"), streaming.
import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ModelProvider, StreamEvent, ToolCall, ModelMessage } from './types.js';
import { ProviderError } from './types.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
/** Models that accept the server-side refusal fallback chain. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicOptions {
  apiKey: string;
  /** Only set by tests; production always talks to the default API host. */
  baseUrl?: string;
  fetch: typeof fetch;
}

type Block = Anthropic.Beta.BetaContentBlockParam;

function toParams(messages: ModelMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content: Block[] = [];
      for (const p of m.content) {
        if (p.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: p.mime as 'image/png', data: p.dataB64 } });
        else if (p.text) content.push({ type: 'text', text: p.text });
      }
      if (content.length) out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      // Inside one tool loop the provider's own blocks (incl. thinking) are replayed unchanged.
      if (Array.isArray(m.native)) {
        out.push({ role: 'assistant', content: m.native as Block[] });
        continue;
      }
      const content: Block[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input as Record<string, unknown> });
      if (content.length) out.push({ role: 'assistant', content });
    } else {
      // All tool results of one turn go back in a single user message.
      const block: Block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => (b as { type: string }).type === 'tool_result')) {
        (last.content as Block[]).push(block);
      } else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

function mapError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', 'the Anthropic API rejected the key');
  if (e instanceof Anthropic.RateLimitError) return new ProviderError('rate_limited', 'the Anthropic API is rate limiting requests');
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) return new ProviderError('bad_request', `the Anthropic API refused the request: ${e.message.slice(0, 300)}`);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError('unavailable', 'cannot reach the Anthropic API');
  if (e instanceof Anthropic.APIError) return new ProviderError('unavailable', `the Anthropic API failed (${e.status ?? 'error'})`);
  return e instanceof Error ? e : new Error(String(e));
}

export class AnthropicProvider implements ModelProvider {
  private client: Anthropic;
  constructor(private o: AnthropicOptions) {
    this.client = new Anthropic({ apiKey: o.apiKey, ...(o.baseUrl ? { baseURL: o.baseUrl } : {}), fetch: o.fetch, maxRetries: 2 });
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = [];
      for await (const m of this.client.models.list()) {
        ids.push(m.id);
        if (ids.length >= 200) break;
      }
      return ids;
    } catch (e) {
      throw mapError(e);
    }
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const model = req.model || ANTHROPIC_DEFAULT_MODEL;
    const fallback = FALLBACK_MODELS.has(model) && !this.o.baseUrl;
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model,
      max_tokens: 64000,
      stream: true,
      ...(req.system ? { system: req.system } : {}),
      messages: toParams(req.messages),
      ...(req.tools.length
        ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema, eager_input_streaming: true })) }
        : {}),
      // A refused request is re-run on a fallback model inside the same call.
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    } as Anthropic.Beta.MessageCreateParamsStreaming;
    let text = '';
    try {
      const { stream: _s, ...rest } = params;
      const stream = this.client.beta.messages.stream(rest as Anthropic.Beta.MessageCreateParamsNonStreaming, { signal: req.signal });
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          yield { type: 'text', text: ev.delta.text };
        }
      }
      const msg = await stream.finalMessage();
      const toolCalls: ToolCall[] = msg.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const stop = msg.stop_reason === 'refusal' ? 'refusal' : msg.stop_reason === 'max_tokens' ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end';
      yield {
        type: 'done',
        text,
        toolCalls: stop === 'tool_use' ? toolCalls : [],
        usage: { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0, costUsd: null },
        stop,
        native: msg.content,
      };
    } catch (e) {
      if (req.signal.aborted) throw e;
      throw mapError(e);
    }
  }
}
