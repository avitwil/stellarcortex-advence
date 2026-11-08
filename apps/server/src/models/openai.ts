// OpenAI-compatible chat completions with streaming (local servers, OpenAI, any compatible API).
import type { ChatRequest, ModelProvider, StreamEvent, ToolCall, ModelMessage } from './types.js';
import { ProviderError } from './types.js';
import { sseEvents } from './sse.js';

export interface OpenAiOptions {
  baseUrl: string;
  apiKey?: string;
  fetch: typeof fetch;
}

function toOpenAi(system: string, messages: ModelMessage[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: 'system', content: system });
  const images: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === 'user') {
      const onlyText = m.content.every((p) => p.type === 'text');
      out.push({
        role: 'user',
        content: onlyText
          ? m.content.map((p) => (p as { text: string }).text).join('\n\n')
          : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.dataB64}` } })),
      });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      // Tool messages carry text only; screenshots follow, after the last tool message of the
      // turn, as one user message.
      for (const p of m.images ?? []) images.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.dataB64}` } });
      const next = messages[i + 1];
      if (images.length && next?.role !== 'tool') {
        out.push({ role: 'user', content: [{ type: 'text', text: 'Screenshots from the tool calls above:' }, ...images] });
        images.length = 0;
      }
    }
  }
  return out;
}

async function fail(res: Response): Promise<never> {
  const text = (await res.text().catch(() => '')).slice(0, 300);
  if (res.status === 401 || res.status === 403) throw new ProviderError('auth', 'the model source rejected the key');
  if (res.status === 429) throw new ProviderError('rate_limited', 'the model source is rate limiting requests');
  if (res.status >= 400 && res.status < 500) throw new ProviderError('bad_request', `the model source refused the request (${res.status}) ${text}`);
  throw new ProviderError('unavailable', `the model source failed (${res.status})`);
}

export class OpenAiProvider implements ModelProvider {
  constructor(private o: OpenAiOptions) {}

  private url(p: string): string {
    return this.o.baseUrl.replace(/\/+$/, '') + p;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) };
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const res = await this.o.fetch(this.url('/models'), { headers: this.headers(), signal, redirect: 'error' });
    if (!res.ok) await fail(res);
    const j = (await res.json()) as { data?: { id?: unknown }[] };
    return (j.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean).slice(0, 500);
  }

  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body = {
      model: req.model,
      messages: toOpenAi(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    };
    let res: Response;
    try {
      res = await this.o.fetch(this.url('/chat/completions'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: req.signal, redirect: 'error' });
    } catch (e) {
      if (req.signal.aborted) throw e;
      throw new ProviderError('unavailable', 'cannot reach the model source');
    }
    if (!res.ok || !res.body) await fail(res);
    let text = '';
    let finish = '';
    let usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null = null;
    const calls = new Map<number, { id: string; name: string; args: string }>();
    for await (const ev of sseEvents(res.body!, req.signal)) {
      if (ev.data === '[DONE]') break;
      let j: any;
      try {
        j = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (j.error) throw new ProviderError('failed', String(j.error.message ?? 'model error').slice(0, 300));
      const ch = j.choices?.[0];
      const delta = ch?.delta;
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content;
        yield { type: 'text', text: delta.content };
      }
      for (const tc of delta?.tool_calls ?? []) {
        const i = Number(tc.index ?? 0);
        const cur = calls.get(i) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(i, cur);
      }
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (j.usage) {
        // Cost only when the provider reports it (FR-BOT-05); OpenAI-compatible routers may.
        const cost = typeof j.usage.cost === 'number' ? j.usage.cost : null;
        usage = { inputTokens: Number(j.usage.prompt_tokens ?? 0), outputTokens: Number(j.usage.completion_tokens ?? 0), costUsd: cost };
      }
    }
    const toolCalls: ToolCall[] = [...calls.values()].map((c, i) => {
      let input: unknown = {};
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        input = { __invalid: c.args.slice(0, 200) };
      }
      return { id: c.id || `call_${i}`, name: c.name, input };
    });
    yield {
      type: 'done',
      text,
      toolCalls,
      usage,
      stop: toolCalls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end',
    };
  }
}
