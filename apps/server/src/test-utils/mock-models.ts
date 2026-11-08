// Scriptable mock model servers (OpenAI-compatible and Anthropic, streaming) and fake
// subscription CLIs for tests (FR-BOT-04, FR-BOT-05).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export interface Turn {
  text?: string[];
  tool?: { name: string; input: unknown };
  usage?: { input: number; output: number; cost?: number };
  status?: number;
  /** wait this long (with the stream open) before answering */
  delayMs?: number;
}
export interface SeenRequest { kind: 'openai' | 'anthropic'; body: any; headers: http.IncomingHttpHeaders }

function lastUserText(kind: 'openai' | 'anthropic', body: any): string {
  const msgs = (body.messages ?? []) as any[];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const t = (m.content as any[]).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    if (t) return t;
    if (kind === 'openai') continue;
  }
  return '';
}

export class MockModels {
  server!: http.Server;
  url = '';
  requests: SeenRequest[] = [];
  /** Decides the reply for each request; the default echoes the last user text. */
  script: (r: SeenRequest) => Turn = (r) => ({ text: ['Echo: ', lastUserText(r.kind, r.body)], usage: { input: 11, output: 7 } });

  static async start(): Promise<MockModels> {
    const m = new MockModels();
    m.server = http.createServer((req, res) => void m.handle(req, res));
    await new Promise<void>((r) => m.server.listen(0, '127.0.0.1', () => r()));
    m.url = `http://127.0.0.1:${(m.server.address() as { port: number }).port}`;
    return m;
  }

  /** fetch that sends the public API hosts to this mock (only used by tests). */
  fetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    if (u.hostname === 'api.openai.com' || u.hostname === 'compat.example.test' || u.hostname === 'api.anthropic.com') {
      return fetch(`${this.url}${u.pathname}${u.search}`, init);
    }
    return fetch(input, init);
  }) as typeof fetch;

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let raw = '';
    for await (const c of req) raw += c;
    const p = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && p.endsWith('/models')) {
      const anthropic = 'anthropic-version' in req.headers;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(anthropic
        ? { data: [{ id: 'claude-opus-5-5', type: 'model', display_name: 'Opus', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: 'claude-opus-5-5', last_id: 'claude-opus-5-5' }
        : { data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }));
      return;
    }
    const kind = p.endsWith('/chat/completions') ? 'openai' : p.endsWith('/messages') ? 'anthropic' : null;
    if (!kind) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const seen: SeenRequest = { kind, body: JSON.parse(raw || '{}'), headers: req.headers };
    this.requests.push(seen);
    const t = this.script(seen);
    if (t.status && t.status !== 200) {
      res.statusCode = t.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { type: 'error', message: 'mock failure' } }));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    if (t.delayMs) {
      res.flushHeaders();
      await new Promise((r) => setTimeout(r, t.delayMs));
      if (res.destroyed || req.destroyed) return;
    }
    if (kind === 'openai') this.openai(res, t);
    else this.anthropic(res, t, seen.body.model);
  }

  private openai(res: http.ServerResponse, t: Turn): void {
    const send = (j: unknown) => res.write(`data: ${JSON.stringify(j)}\n\n`);
    for (const piece of t.text ?? []) send({ choices: [{ index: 0, delta: { content: piece } }] });
    if (t.tool) {
      const args = JSON.stringify(t.tool.input);
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: t.tool.name, arguments: args.slice(0, 5) } }] } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] }, finish_reason: 'tool_calls' }] });
    } else send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    if (t.usage) send({ choices: [], usage: { prompt_tokens: t.usage.input, completion_tokens: t.usage.output, ...(t.usage.cost !== undefined ? { cost: t.usage.cost } : {}) } });
    res.end('data: [DONE]\n\n');
  }

  private anthropic(res: http.ServerResponse, t: Turn, model: string): void {
    const send = (event: string, j: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...j })}\n\n`);
    const u = t.usage ?? { input: 0, output: 0 };
    send('message_start', { message: { id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: u.input, output_tokens: 1 } } });
    let i = 0;
    if (t.text?.length) {
      send('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
      for (const piece of t.text) send('content_block_delta', { index: i, delta: { type: 'text_delta', text: piece } });
      send('content_block_stop', { index: i });
      i++;
    }
    if (t.tool) {
      send('content_block_start', { index: i, content_block: { type: 'tool_use', id: 'toolu_1', name: t.tool.name, input: {} } });
      send('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.tool.input) } });
      send('content_block_stop', { index: i });
    }
    send('message_delta', { delta: { stop_reason: t.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: u.output } });
    send('message_stop', {});
    res.end();
  }
}

/** Fake `claude` and `codex` CLIs that speak the official CLIs' JSON stream formats. */
export function fakeCliDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-fakecli-'));
  const claude = `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== 'sk-ant-oat-test-token-123') { process.stderr.write('Invalid API key · Please run /login'); process.exit(1); }
  const args = process.argv.slice(2);
  if (!args.includes('--strict-mcp-config') || args[args.indexOf('--tools') + 1] !== '') process.exit(3);
  const reply = 'Claude sub: ' + input.trim().split('\\n').pop();
  const out = (j) => process.stdout.write(JSON.stringify(j) + '\\n');
  out({ type: 'system', subtype: 'init' });
  for (const part of [reply.slice(0, 6), reply.slice(6)]) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0.0123, usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 9 } });
});
`;
  const codex = `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (j) => process.stdout.write(JSON.stringify(j) + '\\n');
if (args[0] === 'login') {
  process.stdout.write('\\u001b[1mOpen this link in your browser:\\u001b[0m https://auth.openai.com/codex/device\\n');
  process.stdout.write('Enter this one-time code: ABCD-EFGHI\\n');
  require('fs').writeFileSync(process.env.CODEX_HOME + '/auth.json', JSON.stringify({ tokens: { access_token: 'chatgpt-test-access' } }));
  setTimeout(() => process.exit(0), 200);
  return;
}
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let auth;
  try { auth = JSON.parse(require('fs').readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8')); } catch { process.stderr.write('Not logged in'); process.exit(1); }
  if (auth.tokens.access_token !== 'chatgpt-test-access') { process.stderr.write('401 Unauthorized'); process.exit(1); }
  out({ type: 'thread.started' });
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex sub: ' + input.trim().split('\\n').pop() } });
  out({ type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 0, output_tokens: 12 } });
});
`;
  fs.writeFileSync(path.join(dir, 'claude'), claude, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'codex'), codex, { mode: 0o755 });
  return dir;
}
