// A model server for the REAL coding engines (FR-CODE-01 "the same task runs through each
// adapter"): it speaks OpenAI chat completions (OpenCode), the OpenAI Responses API (Codex) and
// the Anthropic Messages API (Claude Agent SDK). First turn: call the engine's shell tool to
// write a.txt; after a tool result: report done.
import http from 'node:http';

export interface EngineMock { url: string; requests: string[]; close(): Promise<void> }

export const SHELL_COMMAND = 'echo hi > a.txt && cat a.txt';

export async function startEngineMock(): Promise<EngineMock> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0]!;
      requests.push(`${req.method} ${url}`);
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'mock-model' }], models: [] }));
        return;
      }
      const j = JSON.parse(raw || '{}');
      if (url.endsWith('/messages/count_tokens')) {
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      if (url.endsWith('/chat/completions')) return chat(j, res);
      if (url.endsWith('/responses')) return responses(j, res);
      if (url.endsWith('/messages')) return messages(j, res);
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

function chat(j: any, res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const done = (j.messages ?? []).some((m: any) => m.role === 'tool');
  const tool = (j.tools ?? []).find((t: any) => t.function?.name === 'bash');
  if (!done && tool) {
    send({ id: 'c1', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: SHELL_COMMAND, description: 'write a.txt' }) } }] }, finish_reason: null }] });
    send({ id: 'c1', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  } else {
    send({ id: 'c2', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done: wrote a.txt' }, finish_reason: null }] });
    send({ id: 'c2', object: 'chat.completion.chunk', model: 'mock-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } });
  }
  res.end('data: [DONE]\n\n');
}

function responses(j: any, res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o: any) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
  send({ type: 'response.created', response: { id: 'r1' } });
  const done = (j.input ?? []).some((m: any) => m.type === 'function_call_output' || m.type === 'custom_tool_call_output');
  const tool = (j.tools ?? []).find((t: any) => /^(exec_command|shell)$/.test(t.name ?? ''));
  if (!done && tool) {
    const args = tool.name === 'exec_command' ? { cmd: SHELL_COMMAND } : { command: ['bash', '-lc', SHELL_COMMAND] };
    send({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc1', name: tool.name, arguments: JSON.stringify(args), call_id: 'call_1' } });
  } else {
    send({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'Done: wrote a.txt' }] } });
  }
  send({ type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } });
  res.end();
}

function messages(j: any, res: http.ServerResponse): void {
  const msgs = (j.messages ?? []) as any[];
  const done = msgs.some((m) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result'));
  const useTool = !done && (j.tools ?? []).some((t: any) => t.name === 'Bash');
  const content = useTool ? [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: SHELL_COMMAND, description: 'write a.txt' } }] : [{ type: 'text', text: 'Done: wrote a.txt' }];
  const stop = useTool ? 'tool_use' : 'end_turn';
  if (!j.stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o: any) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
  send({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  content.forEach((c: any, i) => {
    if (c.type === 'text') {
      send({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text } });
    } else {
      send({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
      send({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
    }
    send({ type: 'content_block_stop', index: i });
  });
  send({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  send({ type: 'message_stop' });
  res.end();
}
