// P3 coding engines (FR-CODE-01..05): the `code` tool runs the Bot's engine in its computer,
// streams commands and diffs to the chat, records usage and resumes the engine session.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPUTER_EVENTS } from '@advence/protocol';
import { startTestServer, ownerClient, type TestClient, type TestEnv } from './test-utils/harness.js';
import { MockModels, type SeenRequest } from './test-utils/mock-models.js';
import { fakeEngines, readLog, type FakeEngines } from './test-utils/fake-engines.js';
import { startEngineMock, SHELL_COMMAND } from './test-utils/engine-mock.js';
import { LocalHost } from './test-utils/local-host.js';
import { opencodeConfig } from './engines/opencode.js';
import type { BusEvent } from './events.js';

let models: MockModels;
let env: TestEnv;
let owner: TestClient;
let fakes: FakeEngines;
let events: BusEvent[] = [];
const cid = () => `c-${Math.random().toString(36).slice(2, 12)}`;

/** The Bot's chat model asks for the code tool once, then summarizes the engine's report. */
function codeScript(task: string) {
  return (r: SeenRequest) => {
    const msgs = r.body.messages as any[];
    const result = r.kind === 'openai'
      ? msgs.find((m) => m.role === 'tool')?.content
      : msgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c: any) => c.type === 'tool_result')?.content;
    if (result !== undefined) return { text: [`Summary: ${typeof result === 'string' ? result : JSON.stringify(result)}`], usage: { input: 5, output: 5 } };
    return { tool: { name: 'code', input: { task } }, usage: { input: 5, output: 5 } };
  };
}

async function req(method: string, url: string, body?: unknown): Promise<any> {
  const r = await owner.request(method, url, body);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

async function say(convId: string, text: string): Promise<any[]> {
  await req('POST', `/v1/conversations/${convId}/messages`, { text, clientId: cid() });
  await env.server.chat.runtime.idle();
  return req('GET', `/v1/conversations/${convId}/messages`);
}

beforeAll(async () => {
  models = await MockModels.start();
  fakes = fakeEngines();
  env = await startTestServer({
    boot: {
      modelFetch: models.fetch,
      processHost: new LocalHost({ binDir: fakes.binDir, home: fakes.home }),
      testHooks: { anthropicBaseUrl: models.url },
    },
  });
  env.server.ctx.bus.subscribe((e) => void events.push(e));
  owner = await ownerClient(env);
});
afterAll(async () => {
  await env.close();
  await models.close();
});

describe('FR-CODE-01 engine adapters', () => {
  const cases = [
    { engine: 'codex', source: () => ({ kind: 'local', name: 'Local', baseUrl: `${models.url}/v1` }) },
    { engine: 'opencode', source: () => ({ kind: 'local', name: 'Local 2', baseUrl: `${models.url}/v1` }) },
    { engine: 'claude-agent-sdk', source: () => ({ kind: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant-api-test-key-0001' }) },
  ] as const;

  for (const c of cases) {
    it(`the same task runs through the ${c.engine} adapter, with commands and diffs streamed to the chat (FR-CODE-04) and the session resumed`, async () => {
      const src = await req('POST', '/v1/sources', c.source());
      const b = await req('POST', '/v1/bots', { name: `Coder ${c.engine}`, sourceId: src.id, engine: c.engine, tools: ['code'] });
      const conv = (await req('POST', '/v1/conversations/direct', { botId: b.id })).id;
      models.script = codeScript('Write hi to a.txt and fix b.txt');
      events = [];
      fs.rmSync(path.join(fakes.home, 'workspace'), { recursive: true, force: true });

      const list = await say(conv, 'please fix it');
      const reply = list[list.length - 1];
      expect(reply.status, reply.error).toBe('done');
      expect(reply.text).toContain('Summary: Done: wrote a.txt (new)');
      // The engine ran in the Bot's workspace (FR-CODE-02).
      expect(fs.readFileSync(path.join(fakes.home, 'workspace', 'a.txt'), 'utf8')).toBe('hi\n');
      const steps = reply.steps as any[];
      const cmd = steps.find((s) => s.kind === 'command');
      expect(cmd).toMatchObject({ status: 'done', exitCode: 0 });
      expect(cmd.title).toContain('echo hi > a.txt');
      expect(cmd.body).toContain('hi');
      expect(steps.find((s) => s.kind === 'diff')?.title).toContain('b.txt');
      // Steps were pushed live while the engine worked.
      expect(events.some((e) => e.event === COMPUTER_EVENTS.messageSteps && (e.data as any).id === reply.id)).toBe(true);
      // Engine usage is recorded per Bot (FR-BOT-05).
      const usage = await req('GET', '/v1/usage');
      expect(usage.some((u: any) => u.botId === b.id && u.inputTokens >= 20)).toBe(true);

      // A second task in the same chat resumes the engine's session.
      const again = await say(conv, 'and again');
      expect(again[again.length - 1].text).toContain('(resumed)');
    });
  }

  it('FR-CODE-05 credentials reach the engine by environment name only, never in argv; the ChatGPT sign-in exists only during the turn', async () => {
    const lines = readLog(fakes);
    for (const l of lines) expect(JSON.stringify(l.args ?? [])).not.toContain('sk-ant-api-test-key-0001');
    expect(lines.find((l) => l.engine === 'claude')?.env).toContain('ANTHROPIC_API_KEY');
    const oc = lines.find((l) => l.engine === 'opencode');
    expect(oc.keyRef).toBe(true);
    expect(JSON.stringify(oc.config)).not.toContain('sk-');

    // ChatGPT subscription through the Codex engine: auth.json is written for the turn and removed after.
    const { ENGINES } = await import('./engines/index.js');
    const host = new LocalHost({ binDir: fakes.binDir, home: fakes.home });
    const s = ENGINES.codex.start({ host, botId: 'b', cwd: '/home/bot/workspace', signal: AbortSignal.timeout(20_000), auth: { kind: 'chatgpt-subscription', baseUrl: null, secret: '{"tokens":{"access_token":"chatgpt-secret-token"}}', model: null } });
    s.send('task');
    for await (const ev of s.stream()) if (ev.type === 'done') expect(ev.ok).toBe(true);
    const last = readLog(fakes).filter((l) => l.engine === 'codex').pop();
    expect(last.auth).toBe(true);
    expect(last.codexHome).toBe(path.join(fakes.home, '.advence/codex'));
    expect(JSON.stringify(last.args)).not.toContain('chatgpt-secret-token');
    expect(fs.existsSync(path.join(last.codexHome, 'auth.json'))).toBe(false);
  });

  it('an engine that cannot use the Bot\'s model source answers with a clear tool error', async () => {
    const src = await req('POST', '/v1/sources', { kind: 'local', name: 'Local 3', baseUrl: `${models.url}/v1` });
    const b = await req('POST', '/v1/bots', { name: 'Mismatch', sourceId: src.id, engine: 'claude-agent-sdk', tools: ['code'] });
    const conv = (await req('POST', '/v1/conversations/direct', { botId: b.id })).id;
    models.script = codeScript('task');
    const list = await say(conv, 'go');
    expect(list[list.length - 1].text).toContain('cannot use its model source');
  });

  it('OpenCode gets the provider for each source kind, with the key as an env reference', () => {
    const base = { host: new LocalHost({ binDir: '' }), botId: 'b', cwd: '/w', signal: new AbortController().signal };
    expect(opencodeConfig({ ...base, auth: { kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', secret: '', model: 'qwen3' } })).toMatchObject({ model: 'advence/qwen3', config: { provider: { advence: { options: { baseURL: 'http://127.0.0.1:11434/v1', apiKey: '{env:ADVENCE_MODEL_KEY}' } } } } });
    expect(opencodeConfig({ ...base, auth: { kind: 'anthropic', baseUrl: null, secret: 'k', model: null } }).model).toMatch(/^anthropic\//);
    expect(opencodeConfig({ ...base, auth: { kind: 'openai', baseUrl: null, secret: 'k', model: 'gpt-5' } }).model).toBe('openai/gpt-5');
  });
});

// The real engines from npm (installed by CI into ADVENCE_REAL_ENGINES_HOME) against a mock
// model server that speaks each engine's API: the same task, end to end, per adapter.
const REAL = process.env.ADVENCE_REAL_ENGINES_HOME;
describe.runIf(REAL)('FR-CODE-01 real engines', () => {
  for (const engine of ['opencode', 'codex', 'claude-agent-sdk'] as const) {
    it(`${engine}: runs a shell command in the workspace through the real engine`, async () => {
      const mock = await startEngineMock();
      const home = fs.mkdtempSync(path.join(REAL!, `home-${engine}-`));
      fs.symlinkSync(path.join(REAL!, '.local'), path.join(home, '.local'));
      const { ENGINES } = await import('./engines/index.js');
      const host = new LocalHost({ binDir: path.join(REAL!, '.local', 'bin'), home });
      const auth = engine === 'claude-agent-sdk'
        ? { kind: 'anthropic' as const, baseUrl: null, secret: 'sk-ant-test', model: 'claude-test' }
        : { kind: 'local' as const, baseUrl: `${mock.url}/v1`, secret: 'none', model: 'mock-model' };
      const s = ENGINES[engine].start({ host, botId: 'b', cwd: '/home/bot/workspace', auth, signal: AbortSignal.timeout(170_000), anthropicBaseUrl: mock.url });
      s.send(`Run this exact shell command: ${SHELL_COMMAND}`);
      const evs: any[] = [];
      for await (const ev of s.stream()) evs.push(ev);
      await mock.close();
      const done = evs.find((e) => e.type === 'done');
      expect(done, JSON.stringify(evs.slice(-3))).toMatchObject({ ok: true });
      expect(fs.readFileSync(path.join(home, 'workspace', 'a.txt'), 'utf8')).toBe('hi\n');
      expect(evs.some((e) => e.type === 'step' && e.step.kind === 'command' && e.step.title.includes('echo hi'))).toBe(true);
      expect(s.sessionId).toBeTruthy();
    }, 180_000);
  }
});
