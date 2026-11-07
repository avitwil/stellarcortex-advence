// Fake coding engines for tests (FR-CODE-01): they print the same JSONL as the real Claude Agent
// SDK, Codex CLI and OpenCode (captured from the real tools) and really run the shell command and
// file edit they report, in the working directory. Each records its argv and environment names.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface FakeEngines { binDir: string; home: string; log: string }

const common = (log: string) => `
const fs = require('node:fs');
const cp = require('node:child_process');
const log = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(o) + '\\n');
const out = (j) => process.stdout.write(JSON.stringify(j) + '\\n');
const sh = (c) => { try { return { out: cp.execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 }; } catch (e) { return { out: String(e.stdout || '') + String(e.stderr || ''), code: e.status ?? 1 }; } };
`;

export function fakeEngines(): FakeEngines {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-engines-'));
  const binDir = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const log = path.join(root, 'log.jsonl');
  fs.mkdirSync(binDir);
  fs.mkdirSync(home);

  // Codex CLI: `codex exec [resume <id>] --json ... -` (prompt on stdin).
  fs.writeFileSync(path.join(binDir, 'codex'), `#!/usr/bin/env node
${common(log)}
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const resume = args[1] === 'resume' ? args[2] : null;
  log({ engine: 'codex', args, prompt, cwd: process.cwd(), env: Object.keys(process.env).filter((k) => /CODEX|OPENAI|ADVENCE/.test(k)), codexHome: process.env.CODEX_HOME, auth: fs.existsSync((process.env.CODEX_HOME || '') + '/auth.json') });
  if (!process.env.CODEX_API_KEY && !process.env.ADVENCE_MODEL_KEY && !fs.existsSync((process.env.CODEX_HOME || '') + '/auth.json')) { process.stderr.write('401 Unauthorized'); process.exit(1); }
  out({ type: 'thread.started', thread_id: resume || '01a1b7d7-2b64-79e2-aaa3-6fc073276d18' });
  out({ type: 'turn.started' });
  const cmd = "/bin/bash -lc 'echo hi > a.txt && cat a.txt'";
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: cmd, aggregated_output: '', exit_code: null, status: 'in_progress' } });
  const r = sh('echo hi > a.txt && cat a.txt');
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: cmd, aggregated_output: r.out, exit_code: r.code, status: 'completed' } });
  fs.writeFileSync('b.txt', 'fixed\\n');
  out({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'b.txt', kind: 'add' }], status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Done: wrote a.txt (' + (resume ? 'resumed' : 'new') + ')' } });
  out({ type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 10 } });
});
`, { mode: 0o755 });

  // OpenCode: `opencode run --format json -m provider/model [--session id] -- <prompt>`.
  fs.writeFileSync(path.join(binDir, 'opencode'), `#!/usr/bin/env node
${common(log)}
const args = process.argv.slice(2);
const si = args.indexOf('--session');
const session = si >= 0 ? args[si + 1] : 'ses_fake123';
const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
log({ engine: 'opencode', args, cwd: process.cwd(), env: Object.keys(process.env).filter((k) => /OPENCODE|ADVENCE/.test(k)), config: cfg, keyRef: JSON.stringify(cfg).includes('{env:ADVENCE_MODEL_KEY}') });
if (!process.env.ADVENCE_MODEL_KEY) process.exit(2);
const ev = (type, part) => out({ type, timestamp: Date.now(), sessionID: session, part: { sessionID: session, ...part } });
ev('step_start', { type: 'step-start' });
const r = sh('echo hi > a.txt && cat a.txt');
ev('tool_use', { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'echo hi > a.txt && cat a.txt' }, output: r.out, metadata: { output: r.out, exit: r.code } } });
fs.writeFileSync('b.txt', 'fixed\\n');
ev('tool_use', { type: 'tool', tool: 'edit', callID: 'call_2', state: { status: 'completed', input: { filePath: 'b.txt', oldString: 'bug', newString: 'fixed' }, output: '', metadata: { diff: '--- b.txt\\n+++ b.txt\\n-bug\\n+fixed' } } });
ev('step_finish', { type: 'step-finish', reason: 'tool-calls', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.002 });
ev('text', { type: 'text', text: 'Done: wrote a.txt (' + (si >= 0 ? 'resumed' : 'new') + ')' });
ev('step_finish', { type: 'step-finish', reason: 'stop', tokens: { input: 20, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.001 });
`, { mode: 0o755 });

  // Claude Agent SDK: a module with query() in the Bot's home, where the installer puts it.
  const sdkDir = path.join(home, '.local/lib/node_modules/@anthropic-ai/claude-agent-sdk');
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'sdk.mjs'), `
import fs from 'node:fs';
import cp from 'node:child_process';
const log = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(o) + '\\n');
export async function* query({ prompt, options }) {
  log({ engine: 'claude', prompt, options, cwd: process.cwd(), env: Object.keys(process.env).filter((k) => /ANTHROPIC|CLAUDE/.test(k)) });
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error('401 authentication');
  const sid = options.resume || '25f9250f-7b5c-4ea3-ae18-72e152c1e4eb';
  yield { type: 'system', subtype: 'init', session_id: sid, cwd: options.cwd, tools: ['Bash', 'Edit'] };
  yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi > a.txt && cat a.txt' } }] } };
  const out = cp.execSync('echo hi > a.txt && cat a.txt', { encoding: 'utf8' });
  yield { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: out, is_error: false }] } };
  yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: 'b.txt', old_string: 'bug', new_string: 'fixed' } }] } };
  fs.writeFileSync('b.txt', 'fixed\\n');
  yield { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok', is_error: false }] } };
  yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done: wrote a.txt (' + (options.resume ? 'resumed' : 'new') + ')' }] } };
  yield { type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'Done', total_cost_usd: 0.0042, usage: { input_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 12 } };
}
`);
  return { binDir, home, log };
}

export function readLog(f: FakeEngines): any[] {
  if (!fs.existsSync(f.log)) return [];
  return fs.readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
