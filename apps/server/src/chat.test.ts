// P2: Bots, chat, model router, usage, Library, search, push and activity.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_EVENTS } from '@advence/protocol';
import { startTestServer, ownerClient, pairedClient, type TestClient, type TestEnv } from './test-utils/harness.js';
import { MockModels, fakeCliDir } from './test-utils/mock-models.js';
import { LocalHost } from './models/host.js';
import type { BusEvent } from './events.js';

let models: MockModels;
let env: TestEnv;
let owner: TestClient;
let events: BusEvent[] = [];
let pushes: { url: string; body: string }[] = [];
const cliDir = fakeCliDir();

const defaultScript = new MockModels().script;
const cid = () => `c-${Math.random().toString(36).slice(2, 12)}`;

async function boot(dataDir?: string, unlockDir?: string): Promise<void> {
  env = await startTestServer({
    dataDir,
    unlockDir,
    boot: {
      modelFetch: ((input: string | URL | Request, init?: RequestInit) => {
        const u = String(input instanceof Request ? input.url : input);
        if (u.startsWith('https://push.example.test/')) {
          pushes.push({ url: u, body: String(init?.body ?? '') });
          return Promise.resolve(new Response('', { status: 200 }));
        }
        return models.fetch(input, init);
      }) as typeof fetch,
      processHost: new LocalHost({ binDir: cliDir }),
      testHooks: { anthropicBaseUrl: undefined },
    },
  });
  env.server.ctx.bus.subscribe((e) => void events.push(e));
}

async function source(c: TestClient, body: Record<string, unknown>): Promise<string> {
  const r = await c.request('POST', '/v1/sources', body);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.id;
}

async function bot(c: TestClient, body: Record<string, unknown>): Promise<any> {
  const r = await c.request('POST', '/v1/bots', body);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

async function direct(c: TestClient, botId: string): Promise<string> {
  const r = await c.request('POST', '/v1/conversations/direct', { botId });
  expect(r.status).toBe(200);
  return r.json.id;
}

async function say(c: TestClient, convId: string, text: string, extra: Record<string, unknown> = {}): Promise<any> {
  const r = await c.request('POST', `/v1/conversations/${convId}/messages`, { text, clientId: cid(), ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  await env.server.chat.runtime.idle();
  return r.json;
}

async function messages(c: TestClient, convId: string, parentId?: string): Promise<any[]> {
  const r = await c.request('GET', `/v1/conversations/${convId}/messages${parentId ? `?parentId=${parentId}` : ''}`);
  expect(r.status).toBe(200);
  return r.json;
}

beforeAll(async () => {
  models = await MockModels.start();
  await boot();
  owner = await ownerClient(env);
});
afterAll(async () => {
  await env.close();
  await models.close();
});
beforeEach(() => {
  events = [];
  pushes = [];
  models.requests = [];
  models.script = defaultScript;
});
afterEach(async () => {
  await env.server.chat.runtime.idle();
});

describe('FR-BOT-04 model router: every source kind round-trips a chat', () => {
  it('local OpenAI-compatible server (owner only), with model listing', async () => {
    const id = await source(owner, { kind: 'local', name: 'LAN llama', baseUrl: `${models.url}/v1` });
    const list = await owner.request('GET', `/v1/sources/${id}/models`);
    expect(list.json.models).toEqual(['mock-model-a', 'mock-model-b']);
    const b = await bot(owner, { name: 'Local', sourceId: id });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'hello local');
    const m = await messages(owner, conv);
    expect(m.map((x) => [x.author, x.text, x.status])).toEqual([
      ['user', 'hello local', 'done'],
      ['bot', 'Echo: hello local', 'done'],
    ]);
    // No model set: the first model the server lists is used.
    expect(models.requests[0]!.body.model).toBe('mock-model-a');
    expect(models.requests[0]!.body.messages[0]).toMatchObject({ role: 'system' });
  });

  it('OpenAI API key', async () => {
    const id = await source(owner, { kind: 'openai', name: 'OpenAI', apiKey: 'sk-test-openai-key' });
    const b = await bot(owner, { name: 'Oai', sourceId: id, model: 'gpt-test' });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'hi openai');
    expect((await messages(owner, conv)).at(-1).text).toBe('Echo: hi openai');
    expect(models.requests[0]!.headers.authorization).toBe('Bearer sk-test-openai-key');
    expect(models.requests[0]!.body.model).toBe('gpt-test');
  });

  it('any OpenAI-compatible API needs https', async () => {
    const bad = await owner.request('POST', '/v1/sources', { kind: 'openai-compatible', name: 'x', baseUrl: 'http://compat.example.test/v1', apiKey: 'k-123' });
    expect(bad.json.error).toBe('https_required');
    const id = await source(owner, { kind: 'openai-compatible', name: 'Compat', baseUrl: 'https://compat.example.test/v1', apiKey: 'k-compat' });
    const b = await bot(owner, { name: 'Compat bot', sourceId: id, model: 'm1' });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'hi compat');
    expect((await messages(owner, conv)).at(-1).text).toBe('Echo: hi compat');
  });

  it('Anthropic API key through the official SDK, default model, streaming', async () => {
    const id = await source(owner, { kind: 'anthropic', name: 'Anthropic', apiKey: 'sk-ant-test-key' });
    const b = await bot(owner, { name: 'Claude bot', sourceId: id });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'hi anthropic');
    expect((await messages(owner, conv)).at(-1).text).toBe('Echo: hi anthropic');
    const req = models.requests[0]!;
    expect(req.kind).toBe('anthropic');
    expect(req.headers['x-api-key'] ?? req.headers.authorization).toMatch(/^(Bearer )?sk-ant-test-key$/);
    expect(req.body.model).toBe('claude-opus-5-5');
    expect(req.body.stream).toBe(true);
    const deltas = events.filter((e) => e.event === CHAT_EVENTS.messageDelta).map((e) => (e.data as { text: string }).text);
    expect(deltas.join('')).toBe('Echo: hi anthropic');
  });

  it('Claude subscription through the Claude Code CLI (token from claude setup-token)', async () => {
    const id = await source(owner, { kind: 'claude-subscription', name: 'My Claude', token: 'sk-ant-oat-test-token-123' });
    const list = await owner.request('GET', '/v1/sources');
    expect(list.json.find((s: any) => s.id === id)).toMatchObject({ signedIn: true, hasKey: false });
    const b = await bot(owner, { name: 'Sub', sourceId: id });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'hi sub');
    const last = (await messages(owner, conv)).at(-1);
    expect(last.status).toBe('done');
    expect(last.text).toBe('Claude sub: hi sub');
  });

  it('ChatGPT subscription through the Codex CLI device login', async () => {
    const id = await source(owner, { kind: 'chatgpt-subscription', name: 'My ChatGPT' });
    const start = await owner.request('POST', `/v1/sources/${id}/login`);
    expect(start.json).toMatchObject({ state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGHI' });
    for (let i = 0; i < 50; i++) {
      const s = await owner.request('GET', `/v1/sources/${id}/login`);
      if (s.json.state !== 'waiting') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await owner.request('GET', `/v1/sources/${id}/login`)).json.state).toBe('done');
    const b = await bot(owner, { name: 'Codex sub', sourceId: id });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'hi codex');
    expect((await messages(owner, conv)).at(-1).text).toBe('Codex sub: hi codex');
  });

  it('a provider error is shown on the reply, not lost', async () => {
    const id = await source(owner, { kind: 'openai', name: 'Broken', apiKey: 'sk-bad' });
    const b = await bot(owner, { name: 'Broken bot', sourceId: id, model: 'x' });
    models.script = () => ({ status: 401 });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'hello');
    const last = (await messages(owner, conv)).at(-1);
    expect(last).toMatchObject({ author: 'bot', status: 'error', error: 'auth' });
  });

  it('a Bot without a model source answers with an error', async () => {
    const b = await bot(owner, { name: 'No source' });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'hello');
    expect((await messages(owner, conv)).at(-1)).toMatchObject({ status: 'error', error: 'no_model_source' });
  });
});

describe('FR-BOT-05 usage per Bot per source', () => {
  it('tokens and cost match what the providers reported', async () => {
    const src = await source(owner, { kind: 'openai-compatible', name: 'Metered', baseUrl: 'https://compat.example.test/v1', apiKey: 'k-m' });
    const b = await bot(owner, { name: 'Metered bot', sourceId: src, model: 'm' });
    models.script = () => ({ text: ['ok'], usage: { input: 100, output: 40, cost: 0.0021 } });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'one');
    models.script = () => ({ text: ['ok'], usage: { input: 50, output: 10, cost: 0.0004 } });
    await say(owner, conv, 'two');
    const u = await owner.request('GET', '/v1/usage');
    const row = u.json.find((r: any) => r.botId === b.id);
    expect(row).toMatchObject({ sourceId: src, sourceKind: 'openai-compatible', model: 'm', inputTokens: 150, outputTokens: 50, turns: 2 });
    expect(row.costUsd).toBeCloseTo(0.0025, 10);

    // A provider that reports no cost shows none (never estimated).
    const a = await source(owner, { kind: 'anthropic', name: 'A2', apiKey: 'sk-ant-2' });
    const ab = await bot(owner, { name: 'Uncosted', sourceId: a });
    models.script = () => ({ text: ['fine'], usage: { input: 33, output: 22 } });
    await say(owner, await direct(owner, ab.id), 'x');
    const u2 = await owner.request('GET', '/v1/usage');
    expect(u2.json.find((r: any) => r.botId === ab.id)).toMatchObject({ inputTokens: 33, outputTokens: 22, costUsd: null, turns: 1 });

    // Subscription CLI usage, including cached input and reported cost.
    const sub = await owner.request('GET', '/v1/bots');
    const subBot = sub.json.find((x: any) => x.name === 'Sub');
    expect(u2.json.find((r: any) => r.botId === subBot.id)).toMatchObject({ sourceKind: 'claude-subscription', inputTokens: 25, outputTokens: 9, costUsd: 0.0123 });
  });
});

describe('FR-BOT-01 Bot CRUD', () => {
  it('creates, edits and archives a Bot; the primary Bot exists and cannot be deleted', async () => {
    const list = await owner.request('GET', '/v1/bots');
    const primary = list.json[0];
    expect(primary).toMatchObject({ primary: true, name: 'Chief of Staff', tools: ['delegate'] });
    expect((await owner.request('DELETE', `/v1/bots/${primary.id}`)).json.error).toBe('cannot_delete_primary');

    const b = await bot(owner, { name: 'Writer', avatar: 'W', instructions: 'Write well.', engine: 'opencode' });
    const e = await owner.request('PATCH', `/v1/bots/${b.id}`, { instructions: 'Write briefly.', proactive: true, hostControl: true, notify: 'off' });
    expect(e.json).toMatchObject({ instructions: 'Write briefly.', proactive: true, hostControl: true, notify: 'off', engine: 'opencode' });
    // Instructions are sealed at rest (NFR-SEC-04).
    const raw = env.server.ctx.db.prepare('SELECT instructions FROM bots WHERE id = ?').get(b.id) as { instructions: Buffer };
    expect(raw.instructions.toString('utf8')).not.toContain('Write briefly');

    const conv = await direct(owner, b.id);
    env.server.chat.store.insertMessage({ convId: conv, author: 'user', userId: 'x', text: 'kept' });
    expect((await owner.request('DELETE', `/v1/bots/${b.id}`)).status).toBe(200);
    expect((await owner.request('GET', `/v1/bots/${b.id}`)).status).toBe(404);
    // Archived, not destroyed: the row and its chat remain.
    expect(env.server.ctx.db.prepare('SELECT archived_at FROM bots WHERE id = ?').get(b.id)).toMatchObject({ archived_at: expect.any(Number) });
    expect(env.server.ctx.db.prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id = ?').get(conv)).toEqual({ n: 1 });
    expect((await owner.request('GET', '/v1/conversations')).json.find((c: any) => c.id === conv)).toBeUndefined();
  });

  it('rejects a model source that belongs to someone else and unknown tools', async () => {
    expect((await owner.request('POST', '/v1/bots', { name: 'x', sourceId: 'src_nope' })).json.error).toBe('unknown_model_source');
    expect((await owner.request('POST', '/v1/bots', { name: 'x', tools: ['shell'] })).status).toBe(400);
  });
});

describe('FR-BOT-02 the primary Bot delegates and summarizes', () => {
  it('hands the task to another Bot and reports its result back', async () => {
    const src = await source(owner, { kind: 'openai', name: 'Deleg', apiKey: 'sk-d' });
    const researcher = await bot(owner, { name: 'Researcher', sourceId: src, model: 'r' });
    const primary = (await owner.request('GET', '/v1/bots')).json[0];
    await owner.request('PATCH', `/v1/bots/${primary.id}`, { sourceId: src, model: 'p' });
    models.script = (r) => {
      const sys = r.body.messages[0].content as string;
      if (sys.includes('"Researcher"')) return { text: ['The capital is Paris.'], usage: { input: 5, output: 5 } };
      const last = r.body.messages.at(-1);
      if (last.role === 'tool') return { text: ['Summary: ', `Researcher says ${last.content}`], usage: { input: 9, output: 9 } };
      return { tool: { name: 'delegate', input: { bot: 'Researcher', task: 'Find the capital of France.' } }, usage: { input: 7, output: 3 } };
    };
    const conv = await direct(owner, primary.id);
    await say(owner, conv, 'What is the capital of France? Ask the researcher.');
    const reply = (await messages(owner, conv)).at(-1);
    expect(reply).toMatchObject({ author: 'bot', botId: primary.id, status: 'done', text: 'Summary: Researcher says The capital is Paris.' });
    // The tool was offered with the other Bots, and the hand-off shows in the Researcher's chat.
    expect(models.requests[0]!.body.tools[0].function.name).toBe('delegate');
    const rconv = await direct(owner, researcher.id);
    const rm = await messages(owner, rconv);
    expect(rm.map((m) => [m.author, m.text])).toEqual([
      ['system', 'Chief of Staff: Find the capital of France.'],
      ['bot', 'The capital is Paris.'],
    ]);
    const act = await owner.request('GET', '/v1/activity');
    expect(act.json.some((a: any) => a.kind === 'delegate' && a.summary === 'Chief of Staff delegated a task to Researcher')).toBe(true);
  });
});

describe('FR-BOT-03 group chats and hand-offs', () => {
  it('two Bots complete a hand-off in a group chat', async () => {
    const src = await source(owner, { kind: 'openai', name: 'Group', apiKey: 'sk-g' });
    const planner = await bot(owner, { name: 'Planner', sourceId: src, model: 'g' });
    const coder = await bot(owner, { name: 'Coder', sourceId: src, model: 'g' });
    const g = await owner.request('POST', '/v1/conversations/group', { title: 'Launch', botIds: [planner.id, coder.id] });
    expect(g.json).toMatchObject({ kind: 'group', title: 'Launch', botIds: [planner.id, coder.id] });
    models.script = (r) => {
      const sys = r.body.messages[0].content as string;
      if (sys.includes('"Planner"')) return { text: ['Plan ready. @Coder please build step 1.'] };
      return { text: ['Step 1 built.'] };
    };
    await say(owner, g.json.id, '@Planner make a plan');
    const m = await messages(owner, g.json.id);
    expect(m.map((x) => [x.author, x.botId, x.text])).toEqual([
      ['user', null, '@Planner make a plan'],
      ['bot', planner.id, 'Plan ready. @Coder please build step 1.'],
      ['bot', coder.id, 'Step 1 built.'],
    ]);
    expect(m[0].mentions).toEqual([planner.id]);
    expect(m[1].mentions).toEqual([coder.id]);
    // The Coder saw the Planner's message labeled with its name.
    const coderReq = models.requests.find((r) => (r.body.messages[0].content as string).includes('"Coder"'))!;
    expect(JSON.stringify(coderReq.body.messages)).toContain('[Planner] Plan ready.');
  });

  it('hand-offs stop after a bounded number of hops', async () => {
    const src = await source(owner, { kind: 'openai', name: 'Loop', apiKey: 'sk-l' });
    const a = await bot(owner, { name: 'Ping', sourceId: src, model: 'g' });
    const b = await bot(owner, { name: 'Pong', sourceId: src, model: 'g' });
    const g = await owner.request('POST', '/v1/conversations/group', { title: 'Loop', botIds: [a.id, b.id] });
    models.script = (r) => ((r.body.messages[0].content as string).includes('"Ping"') ? { text: ['@Pong your turn'] } : { text: ['@Ping your turn'] });
    await say(owner, g.json.id, '@Ping start');
    const m = await messages(owner, g.json.id);
    expect(m.filter((x) => x.author === 'bot')).toHaveLength(4); // first reply + 3 hops
  });

  it('without a mention the first Bot of the group answers; threads keep their own context', async () => {
    const src = await source(owner, { kind: 'openai', name: 'T', apiKey: 'sk-t' });
    const a = await bot(owner, { name: 'Alpha', sourceId: src, model: 'g' });
    const b = await bot(owner, { name: 'Beta', sourceId: src, model: 'g' });
    const g = await owner.request('POST', '/v1/conversations/group', { title: 'T', botIds: [a.id, b.id] });
    const root = await say(owner, g.json.id, 'top level');
    let m = await messages(owner, g.json.id);
    expect(m.at(-1)).toMatchObject({ botId: a.id, text: 'Echo: top level' });
    await say(owner, g.json.id, 'in thread', { parentId: root.id });
    const thread = await messages(owner, g.json.id, root.id);
    // The thread's context is its parent plus its replies, not the rest of the chat.
    expect(thread.map((x) => x.text)).toEqual(['in thread', 'Echo: top level\n\nin thread']);
    expect(JSON.stringify(models.requests.at(-1)!.body.messages)).not.toContain('Echo: top level');
    m = await messages(owner, g.json.id);
    expect(m.find((x) => x.id === root.id).replyCount).toBe(2);
    expect(m).toHaveLength(2);
    // Replies to a reply are refused (threads are one level).
    const bad = await owner.request('POST', `/v1/conversations/${g.json.id}/messages`, { text: 'x', parentId: thread[0].id, clientId: cid() });
    expect(bad.json.error).toBe('invalid_parent');
  });
});

describe('FR-UI-02 chat view features', () => {
  let conv: string;
  beforeAll(async () => {
    const src = await source(owner, { kind: 'anthropic', name: 'UI', apiKey: 'sk-ui' });
    const b = await bot(owner, { name: 'Viewer', sourceId: src });
    conv = await direct(owner, b.id);
  });

  it('attachments: images go to the model, text files inline; files are sealed at rest', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const img = await owner.request('POST', '/v1/attachments', { name: 'pic.png', mime: 'image/png', dataB64: png.toString('base64') });
    const txt = await owner.request('POST', '/v1/attachments', { name: 'notes.txt', mime: 'text/plain', dataB64: Buffer.from('secret notes').toString('base64') });
    expect(img.status).toBe(200);
    await say(owner, conv, 'look', { attachmentIds: [img.json.id, txt.json.id] });
    const content = models.requests[0]!.body.messages[0].content as any[];
    expect(content.find((p) => p.type === 'image').source).toMatchObject({ type: 'base64', media_type: 'image/png', data: png.toString('base64') });
    expect(content.some((p) => p.type === 'text' && p.text.includes('secret notes'))).toBe(true);
    const got = await owner.request('GET', `/v1/attachments/${txt.json.id}`);
    expect(Buffer.from(got.json.dataB64, 'base64').toString()).toBe('secret notes');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const disk = fs.readFileSync(path.join(env.dataDir, 'attachments', `${txt.json.id}.bin`));
    expect(disk.toString('latin1')).not.toContain('secret notes');
    const m = (await messages(owner, conv)).find((x) => x.text === 'look');
    expect(m.attachments.map((a: any) => a.name)).toEqual(['pic.png', 'notes.txt']);
  });

  it('a retried send with the same clientId is not duplicated', async () => {
    const body = { text: 'once', clientId: 'retry-client-id-1' };
    const a = await owner.request('POST', `/v1/conversations/${conv}/messages`, body);
    const b = await owner.request('POST', `/v1/conversations/${conv}/messages`, body);
    await env.server.chat.runtime.idle();
    expect(a.json.id).toBe(b.json.id);
    expect((await messages(owner, conv)).filter((m) => m.text === 'once')).toHaveLength(1);
  });

  it('reactions toggle', async () => {
    const m = (await messages(owner, conv)).at(-1);
    const r1 = await owner.request('POST', `/v1/messages/${m.id}/reactions`, { emoji: '👍' });
    expect(r1.json.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    const r2 = await owner.request('POST', `/v1/messages/${m.id}/reactions`, { emoji: '👍' });
    expect(r2.json.reactions).toEqual([]);
  });

  it('streaming replies can be stopped', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = models.fetch;
    models.fetch = (async (i: any, init?: RequestInit) => {
      await gate;
      return orig(i, init);
    }) as typeof fetch;
    const r = await owner.request('POST', `/v1/conversations/${conv}/messages`, { text: 'long one', clientId: cid() });
    expect(r.status).toBe(200);
    const created = events.find((e) => e.event === CHAT_EVENTS.messageCreated && (e.data as any).author === 'bot' && (e.data as any).status === 'streaming')!;
    const stop = await owner.request('POST', `/v1/messages/${(created.data as any).id}/stop`);
    expect(stop.status).toBe(200);
    release();
    await env.server.chat.runtime.idle();
    models.fetch = orig;
    expect((await messages(owner, conv)).at(-1)).toMatchObject({ status: 'error', error: 'stopped' });
  });

  it('drafts persist across a server restart, and interrupted replies are marked', async () => {
    expect((await owner.request('PUT', `/v1/conversations/${conv}/draft`, { text: 'half a thought' })).status).toBe(200);
    // A reply that was streaming when the server stopped.
    env.server.chat.store.insertMessage({ convId: conv, author: 'bot', text: 'partial', status: 'streaming' });
    const { dataDir, unlockDir } = env;
    const ownerKey = owner;
    await env.close();
    await boot(dataDir, unlockDir);
    owner = ownerKey;
    owner.url = env.server.url;
    // The session token survives; re-login only if the server dropped it.
    let d = await owner.request('GET', `/v1/conversations/${conv}/draft`);
    if (d.status !== 200) {
      await owner.loginWithCode(env.google, { sub: 'owner-sub', email: 'owner@example.com' });
      d = await owner.request('GET', `/v1/conversations/${conv}/draft`);
    }
    expect(d.json.text).toBe('half a thought');
    expect((await messages(owner, conv)).at(-1)).toMatchObject({ text: 'partial', status: 'error', error: 'interrupted' });
  });
});

describe('FR-UI-01 search, FR-UI-04 Library, activity', () => {
  it('search finds messages (encrypted at rest, indexed in memory), Bots and groups', async () => {
    const src = await source(owner, { kind: 'openai', name: 'S', apiKey: 'sk-s' });
    const b = await bot(owner, { name: 'Searcher', sourceId: src, model: 's' });
    await owner.request('POST', '/v1/conversations/group', { title: 'Zebra project', botIds: [b.id] });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'the quokka migration plan');
    const r = await owner.request('GET', `/v1/search?q=${encodeURIComponent('quok')}`);
    expect(r.json.messages.length).toBeGreaterThanOrEqual(2); // the question and the echo
    expect(r.json.messages[0].snippet).toContain('quokka');
    expect((await owner.request('GET', '/v1/search?q=searcher')).json.bots.map((x: any) => x.name)).toContain('Searcher');
    expect((await owner.request('GET', '/v1/search?q=zebra')).json.groups.map((x: any) => x.title)).toEqual(['Zebra project']);
    // Quotes and FTS operators in the query are harmless.
    expect((await owner.request('GET', `/v1/search?q=${encodeURIComponent('"a" OR NEAR(')}`)).status).toBe(200);
  });

  it('links and images a Bot produces appear in the Library within 5 s', async () => {
    const src = await source(owner, { kind: 'openai', name: 'L', apiKey: 'sk-l2' });
    const b = await bot(owner, { name: 'Linker', sourceId: src, model: 'l' });
    models.script = () => ({ text: ['See [the report](https://example.com/report.pdf), ![chart](https://example.com/c.png) and https://example.com/page.'] });
    const t0 = Date.now();
    await say(owner, await direct(owner, b.id), 'links please');
    const lib = await owner.request('GET', `/v1/library?botId=${b.id}`);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(lib.json.map((i: any) => [i.kind, i.title, i.url]).sort()).toEqual([
      ['file', 'the report', 'https://example.com/report.pdf'],
      ['image', 'chart', 'https://example.com/c.png'],
      ['link', 'https://example.com/page', 'https://example.com/page'],
    ]);
    expect(events.some((e) => e.event === CHAT_EVENTS.libraryAdded)).toBe(true);
    expect((await owner.request('GET', '/v1/search?q=report')).json.files.length).toBeGreaterThan(0);
  });
});

describe('D-18 push: wake-up plus id only, to the configured ntfy server', () => {
  it('only endpoints on the push server are accepted, and the payload carries no content', async () => {
    expect((await owner.request('PUT', '/v1/push', { endpoint: 'https://push.example.test/upAbc' })).json.error).toBe('push_not_configured');
    expect((await owner.request('PATCH', '/v1/notifications', { pushServer: 'https://push.example.test' })).status).toBe(200);
    expect((await owner.request('PUT', '/v1/push', { endpoint: 'https://evil.example.test/upAbc' })).json.error).toBe('endpoint_not_on_push_server');
    const reg = await owner.request('PUT', '/v1/push', { endpoint: 'https://push.example.test/upAbc?up=1' });
    expect(reg.json).toMatchObject({ pushServer: 'https://push.example.test', registered: true, muted: false });

    const src = await source(owner, { kind: 'openai', name: 'P', apiKey: 'sk-p' });
    const b = await bot(owner, { name: 'Notifier', sourceId: src, model: 'p' });
    const conv = await direct(owner, b.id);
    await say(owner, conv, 'top secret words');
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes).toHaveLength(1);
    const last = (await messages(owner, conv)).at(-1);
    expect(JSON.parse(pushes[0]!.body)).toEqual({ t: 'wake', id: last.id });
    expect(pushes[0]!.body).not.toContain('secret');

    // Per-Bot "off" and app-wide mute silence pushes.
    await owner.request('PATCH', `/v1/bots/${b.id}`, { notify: 'off' });
    await say(owner, conv, 'again');
    await owner.request('PATCH', `/v1/bots/${b.id}`, { notify: 'all' });
    await owner.request('PATCH', '/v1/notifications', { muted: true });
    await say(owner, conv, 'and again');
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes).toHaveLength(1);
    await owner.request('PATCH', '/v1/notifications', { muted: false });
  });
});

describe('authorization between users', () => {
  it('a member sees only their own Bots and chats and cannot use subscription or local sources', async () => {
    expect((await owner.request('POST', '/v1/allowlist', { email: 'member@example.com' })).status).toBe(200);
    const m = await pairedClient(env);
    expect((await m.loginWithCode(env.google, { sub: 'member-sub', email: 'member@example.com' })).status).toBe(200);
    expect((await m.request('POST', '/v1/sources', { kind: 'claude-subscription', name: 'x', token: 'sk-ant-oat-xxxxxxxx' })).json.error).toBe('owner_only');
    expect((await m.request('POST', '/v1/sources', { kind: 'local', name: 'x', baseUrl: 'http://127.0.0.1:1/v1' })).json.error).toBe('owner_only');
    const ownerConvs = (await owner.request('GET', '/v1/conversations')).json;
    const victim = ownerConvs[0].id;
    expect((await m.request('GET', `/v1/conversations/${victim}/messages`)).status).toBe(404);
    expect((await m.request('POST', `/v1/conversations/${victim}/messages`, { text: 'x', clientId: cid() })).status).toBe(404);
    const ownerBots = (await owner.request('GET', '/v1/bots')).json;
    expect((await m.request('POST', '/v1/conversations/direct', { botId: ownerBots[0].id })).status).toBe(404);
    expect((await m.request('POST', '/v1/conversations/group', { title: 't', botIds: [ownerBots[0].id] })).status).toBe(404);
    const myBots = (await m.request('GET', '/v1/bots')).json;
    expect(myBots).toHaveLength(1);
    expect(myBots[0].primary).toBe(true);
    expect((await m.request('GET', `/v1/search?q=quokka`)).json.messages).toEqual([]);
    expect((await m.request('GET', '/v1/usage')).json).toEqual([]);
    expect((await m.request('PATCH', '/v1/notifications', { pushServer: 'https://x.example.test' })).json.error).toBe('owner_only');
    // A member's Bot cannot point at the owner's source.
    const ownerSrc = (await owner.request('GET', '/v1/sources')).json[0].id;
    expect((await m.request('POST', '/v1/bots', { name: 'x', sourceId: ownerSrc })).json.error).toBe('unknown_model_source');
    const att = (await owner.request('POST', '/v1/attachments', { name: 'a.txt', mime: 'text/plain', dataB64: 'eA==' })).json.id;
    expect((await m.request('GET', `/v1/attachments/${att}`)).status).toBe(404);
    const mconv = (await m.request('POST', '/v1/conversations/direct', { botId: myBots[0].id })).json.id;
    expect((await m.request('POST', `/v1/conversations/${mconv}/messages`, { text: 'x', attachmentIds: [att], clientId: cid() })).status).toBe(404);
  });
});
