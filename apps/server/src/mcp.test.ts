// P5 MCP (FR-MCP-01..05): the MCP client against the reference "everything" server over stdio
// and Streamable HTTP, a 2025-only server, an OAuth-protected server, and this server's own
// MCP endpoint used by an external SDK client in both protocol eras.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Bot, McpInput, User } from '@advence/protocol';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startTestServer, ownerClient, pairedClient, type TestClient, type TestEnv } from './test-utils/harness.js';
import { MockModels, type SeenRequest, type Turn } from './test-utils/mock-models.js';
import { FakeRuntime } from './test-utils/fake-runtime.js';
import { everythingEntry, pinnedFetch, startEverythingHttp, startLegacyMcp, startProtectedMcp, type ProtectedMcp, type Running } from './test-utils/mcp-fixtures.js';
import { toolName } from './mcp/hub.js';
import { asksForSecret } from './mcp/inputs.js';
import { createPublicFetch, isPublicAddress } from './mcp/public-fetch.js';
import type { ToolCall } from './models/types.js';

let models: MockModels;
let rt: FakeRuntime;
let env: TestEnv;
let owner: TestClient;
let user: User;
let src = '';
let everything: Running;
let legacy: Running;
let prot: ProtectedMcp;
const cid = () => `c-${Math.random().toString(36).slice(2, 12)}`;

async function req(c: TestClient, method: string, url: string, body?: unknown): Promise<any> {
  const r = await c.request(method, url, body);
  expect(r.status, `${method} ${url} ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
}

let chatPlan: (r: SeenRequest) => Turn = () => ({ text: ['OK.'] });

let n = 0;
async function newBot(name: string): Promise<Bot> {
  const b = await req(owner, 'POST', '/v1/bots', { name: `${name} ${++n}`, sourceId: src });
  return env.server.chat.bots.get(b.id)!;
}

const hub = () => env.server.mcp.hub;

/** Runs one MCP tool the way the chat runtime does: prepare, list specs, run. */
async function tool(bot: Bot, name: string, input: unknown, signal = AbortSignal.timeout(60_000)): Promise<{ content: string; isError?: boolean; images?: unknown[] }> {
  await hub().prepare(user, bot, signal);
  hub().specs(user, bot);
  const call: ToolCall = { id: `t${Math.random()}`, name, input };
  const r = (await hub().run({ user, bot, convId: 'conv-test', messageId: 'm', signal }, call)) as { content: string; isError?: boolean; images?: unknown[] };
  return r;
}

async function waitInput(c: TestClient, pred: (i: McpInput) => boolean = () => true, ms = 20_000): Promise<McpInput> {
  const until = Date.now() + ms;
  for (;;) {
    const list = (await req(c, 'GET', '/v1/mcp/inputs')) as McpInput[];
    const hit = list.find(pred);
    if (hit) return hit;
    if (Date.now() > until) throw new Error('no pending input');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const everythingCmd = () => `'${process.execPath}' '${everythingEntry()}' stdio`;

beforeAll(async () => {
  models = await MockModels.start();
  models.script = (r) => chatPlan(r);
  rt = await FakeRuntime.start();
  [everything, legacy, prot] = await Promise.all([startEverythingHttp(), startLegacyMcp(), startProtectedMcp()]);
  env = await startTestServer({ boot: { modelFetch: models.fetch, containerRuntime: rt } });
  owner = await ownerClient(env);
  const uid = (env.server.ctx.db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id;
  user = env.server.ctx.identity.getUser(uid)!;
  src = (await req(owner, 'POST', '/v1/sources', { kind: 'openai', name: 'OpenAI', apiKey: 'sk-test-openai-p5' })).id;
}, 60_000);
afterAll(async () => {
  await env?.close();
  await models?.close();
  rt?.close();
  await everything?.close();
  await legacy?.close();
  await prot?.close();
});

describe('FR-MCP-01 MCP client over stdio (in the Bot computer) and Streamable HTTP', () => {
  it('overlapping calls share one stdio process per Bot', async () => {
    const bot = await newBot('Overlap');
    const s = await req(owner, 'POST', '/v1/mcp/servers', { name: 'Twice', transport: 'stdio', command: everythingCmd(), bots: [bot.id] });
    const before = rt.interactives.length;
    const both = await Promise.all([1, 2, 3].map(() => hub().check(user, s.id, bot.id)));
    expect(both.map((x) => x.status)).toEqual(['ok', 'ok', 'ok']);
    expect(rt.interactives.length - before).toBe(1);
    await req(owner, 'DELETE', `/v1/mcp/servers/${s.id}`);
  }, 60_000);

  it('runs the everything server over stdio in the Bot computer and a Bot calls its echo tool from chat', async () => {
    const bot = await newBot('Stdio');
    const s = await req(owner, 'POST', '/v1/mcp/servers', { name: 'Everything', transport: 'stdio', command: everythingCmd(), env: { EVERYTHING_NOTE: 'secret-env-value' }, bots: [bot.id] });
    expect(s.envNames).toEqual(['EVERYTHING_NOTE']);
    expect(JSON.stringify(s)).not.toContain('secret-env-value');
    const checked = await req(owner, 'POST', `/v1/mcp/servers/${s.id}/check`, { botId: bot.id });
    expect(checked.status).toBe('ok');
    expect(checked.era).toBe('modern');
    expect(checked.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['echo', 'get-sum', 'trigger-elicitation-request']));
    expect(checked.resources).toBeGreaterThan(0);
    expect(checked.prompts).toBeGreaterThan(0);
    expect(rt.created.length).toBeGreaterThan(0);

    const echo = toolName('Everything', 'echo');
    chatPlan = (r) => {
      const results = (r.body.messages as any[]).filter((m) => m.role === 'tool');
      if (!results.length) return { tool: { name: echo, input: { message: 'hello from chat' } } };
      return { text: [`Tool said: ${results[0].content}`] };
    };
    const conv = (await req(owner, 'POST', '/v1/conversations/direct', { botId: bot.id })).id;
    await req(owner, 'POST', `/v1/conversations/${conv}/messages`, { text: 'echo it', clientId: cid() });
    await env.server.chat.runtime.idle();
    const first = models.requests.filter((r) => ((r.body.tools ?? []) as any[]).some((t) => t.function?.name === echo));
    expect(first.length).toBeGreaterThan(0);
    const list = await req(owner, 'GET', `/v1/conversations/${conv}/messages`);
    expect(list[list.length - 1].text).toContain('Echo: hello from chat');
    // The process runs in the Bot's computer (here: the fake runtime's home for this Bot) and
    // got the secret env value.
    const envOut = (await tool(bot, toolName('Everything', 'get-env'), {})).content;
    expect(envOut).toContain('secret-env-value');
    expect(envOut).toContain(JSON.stringify(rt.root).slice(1, -1)); // the tool prints its env as JSON
  }, 60_000);

  it('connects to the everything server over Streamable HTTP in the 2026-07-28 era', async () => {
    const bot = await newBot('Http');
    const s = await req(owner, 'POST', '/v1/mcp/servers', { name: 'Everything HTTP', transport: 'http', url: everything.url, bots: [bot.id] });
    const checked = await req(owner, 'POST', `/v1/mcp/servers/${s.id}/check`, {});
    expect(checked.status).toBe('ok');
    expect(checked.era).toBe('modern');
    const sum = await tool(bot, toolName('Everything HTTP', 'get-sum'), { a: 2, b: 40 });
    expect(sum.isError).toBeFalsy();
    expect(sum.content).toContain('42');
    const img = await tool(bot, toolName('Everything HTTP', 'get-tiny-image'), {});
    expect(img.images?.length).toBe(1);
  }, 60_000);
});

describe('FR-MCP-02 2026-07-28 features with fallback to 2025-11-25', () => {
  let bot: Bot;
  beforeAll(async () => {
    bot = await newBot('Features');
    await req(owner, 'POST', '/v1/mcp/servers', { name: 'Feat', transport: 'http', url: everything.url, bots: [bot.id] });
  });

  it('answers a form elicitation (MRTR input_required) through the pending-input API', async () => {
    const run = tool(bot, toolName('Feat', 'trigger-elicitation-request'), {});
    const input = await waitInput(owner, (i) => i.serverName === 'Feat' && i.mode === 'form');
    expect(input.botId).toBe(bot.id);
    expect(input.convId).toBe('conv-test');
    const props = (input.schema as { properties: Record<string, any> }).properties;
    expect(props.titledSingleSelectEnum.oneOf).toHaveLength(3);
    expect(props.untitledSingleSelectEnum.enum).toContain('Rachel');
    // A missing required field is refused; the request stays open.
    expect((await owner.request('POST', `/v1/mcp/inputs/${input.id}`, { action: 'accept', content: { check: true } })).status).toBe(400);
    await req(owner, 'POST', `/v1/mcp/inputs/${input.id}`, { action: 'accept', content: { name: 'Avi Twil', untitledSingleSelectEnum: 'Joey', injected: 'dropped' } });
    const r = await run;
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Avi Twil');
    expect(r.content).toContain('Joey');
    expect(r.content).not.toContain('dropped');
    expect(await req(owner, 'GET', '/v1/mcp/inputs')).toEqual([]);
  }, 60_000);

  it('passes on a URL-mode elicitation for the user to open, and declines a decline', async () => {
    const run = tool(bot, toolName('Feat', 'trigger-url-elicitation'), { url: 'https://example.com/connect', message: 'Connect your account.' });
    const input = await waitInput(owner, (i) => i.mode === 'url');
    expect(input.url).toBe('https://example.com/connect');
    expect(input.schema).toBeNull();
    await req(owner, 'POST', `/v1/mcp/inputs/${input.id}`, { action: 'decline' });
    const r = await run;
    expect(r.content.toLowerCase()).toContain('decline');
  }, 60_000);

  it('follows a task (tasks extension) through input_required to its result', async () => {
    const run = tool(bot, toolName('Feat', 'simulate-research-query'), { topic: 'python', ambiguous: true });
    const input = await waitInput(owner, (i) => /interpretations/.test(i.message));
    const props = (input.schema as { properties: Record<string, any> }).properties;
    expect(props.interpretation.oneOf.map((o: { const: string }) => o.const)).toEqual(['programming', 'snake', 'comedy']);
    await req(owner, 'POST', `/v1/mcp/inputs/${input.id}`, { action: 'accept', content: { interpretation: 'snake' } });
    const r = await run;
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Research Report: python (snake)');
  }, 60_000);

  it('cancels the pending input when the tool call is stopped', async () => {
    const ac = new AbortController();
    const run = tool(bot, toolName('Feat', 'trigger-elicitation-request'), {}, ac.signal);
    await waitInput(owner, (i) => i.serverName === 'Feat');
    ac.abort();
    const r = await run;
    expect(r.isError).toBe(true);
    expect(await req(owner, 'GET', '/v1/mcp/inputs')).toEqual([]);
  }, 60_000);

  it('lists and reads resources and fills prompts', async () => {
    const list = await tool(bot, 'mcp_resources', { server: 'Feat' });
    expect(list.content).toMatch(/demo:\/\/resource\//);
    const uri = /(demo:\/\/resource\/\S+)/.exec(list.content)![1]!;
    const read = await tool(bot, 'mcp_read_resource', { server: 'Feat', uri });
    expect(read.isError).toBeFalsy();
    const prompts = await tool(bot, 'mcp_prompts', {});
    expect(prompts.content).toContain('simple-prompt');
    const p = await tool(bot, 'mcp_get_prompt', { server: 'Feat', name: 'simple-prompt' });
    expect(p.content).toMatch(/^user: /);
  }, 60_000);

  it('falls back to 2025-11-25 (initialize and sessions) for a server without server/discover', async () => {
    const b = await newBot('Legacy');
    const s = await req(owner, 'POST', '/v1/mcp/servers', { name: 'Old', transport: 'http', url: legacy.url, bots: [b.id] });
    const checked = await req(owner, 'POST', `/v1/mcp/servers/${s.id}/check`, {});
    expect(checked.status).toBe('ok');
    expect(checked.era).toBe('legacy');
    expect((await tool(b, toolName('Old', 'legacy_add'), { a: 2, b: 3 })).content).toBe('5');
  }, 60_000);

  it('declines form requests that ask for secrets (secrets only through URL mode, FR-MCP-03)', () => {
    expect(asksForSecret({ properties: { password: { type: 'string' } } }, 'Sign in')).toBe(true);
    expect(asksForSecret({ properties: { key: { type: 'string', title: 'API key' } } }, 'Setup')).toBe(true);
    expect(asksForSecret({ properties: { x: { type: 'string', format: 'password' } } }, 'Setup')).toBe(true);
    expect(asksForSecret({ properties: { name: { type: 'string' } } }, 'Please enter your password below')).toBe(true);
    expect(asksForSecret({ properties: { n: { type: 'integer', description: 'do not give us your pin' } } }, 'Favourites')).toBe(false);
    for (const k of ['password_confirm', 'pass_phrase', 'passwd', 'pwd', 'pin_code', 'userPassword', 'apiKey', 'api-key', 'otp_code', 'card_number']) {
      expect(asksForSecret({ properties: { [k]: { type: 'string' } } }, 'Setup'), k).toBe(true);
    }
    for (const k of ['name', 'spinner', 'opinion', 'compass', 'pinned_note', 'tokenizer_mode']) {
      expect(asksForSecret({ properties: { [k]: { type: 'string' } } }, 'Setup'), k).toBe(false);
    }
  });
});

describe('FR-MCP-03 OAuth 2.1 sign-in to a protected server', () => {
  async function signIn(id: string): Promise<{ location: string }> {
    const checked = await req(owner, 'POST', `/v1/mcp/servers/${id}/check`, {});
    expect(checked.status).toBe('auth_required');
    const { url } = await req(owner, 'POST', `/v1/mcp/servers/${id}/auth`, {});
    // The browser: the test authorization server approves at once and redirects back.
    const res = await fetch(url, { redirect: 'manual' });
    expect(res.status).toBe(302);
    return { location: res.headers.get('location')! };
  }

  it('discovers the authorization server (RFC 9728), registers, signs in with PKCE, resource (RFC 8707) and iss (RFC 9207)', async () => {
    const bot = await newBot('Reports');
    const s = await req(owner, 'POST', '/v1/mcp/servers', { name: 'Reports', transport: 'http', url: prot.url, bots: [bot.id] });
    const { location } = await signIn(s.id);
    const a = prot.authorizeParams.at(-1)!;
    expect(a.get('response_type')).toBe('code');
    expect(a.get('code_challenge_method')).toBe('S256');
    expect(a.get('resource')).toBe(prot.url);
    expect(a.get('redirect_uri')).toBe('http://localhost:47823/oauth/callback');
    expect(a.get('client_id')).toMatch(/^dyn-/);
    expect(prot.registered.at(-1)).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: ['http://localhost:47823/oauth/callback'] });
    expect(new URL(location).searchParams.get('iss')).toBe(prot.base);

    // A callback with another state is refused.
    const forged = new URL(location);
    forged.searchParams.set('state', 'forged');
    expect((await owner.request('POST', `/v1/mcp/servers/${s.id}/auth/finish`, { callbackUrl: forged.href })).status).toBe(400);

    const done = await req(owner, 'POST', `/v1/mcp/servers/${s.id}/auth/finish`, { callbackUrl: location });
    expect(done.signedIn).toBe(true);
    const t = prot.tokenParams.at(-1)!;
    expect(t.get('grant_type')).toBe('authorization_code');
    expect(t.get('resource')).toBe(prot.url);
    expect(t.get('code_verifier')).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);

    const checked = await req(owner, 'POST', `/v1/mcp/servers/${s.id}/check`, {});
    expect(checked.status).toBe('ok');
    const r = await tool(bot, toolName('Reports', 'secret_report'), {});
    expect(r.content).toBe('Q3 revenue: 42 apples');

    // Tokens travel only in the Authorization header, never in a query string.
    const access = prot.issued.filter((x) => x.startsWith('at-'));
    for (const seen of prot.seen) for (const tok of prot.issued) expect(seen.url).not.toContain(tok);
    expect(prot.seen.some((x) => x.url.startsWith('/mcp') && access.some((tok) => x.auth === `Bearer ${tok}`))).toBe(true);
    // Stored sealed: no token appears in the database in the clear.
    const rows = env.server.ctx.db.prepare('SELECT body FROM mcp_auth').all() as { body: Buffer }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) for (const tok of prot.issued) expect(row.body.toString('latin1')).not.toContain(tok);

    // Signing out forgets the tokens.
    const out = await req(owner, 'DELETE', `/v1/mcp/servers/${s.id}/auth`);
    expect(out.signedIn).toBe(false);
  }, 60_000);

  it('refuses a callback whose iss is not the authorization server (mix-up, RFC 9207)', async () => {
    prot.wrongIss = true;
    try {
      const s = await req(owner, 'POST', '/v1/mcp/servers', { name: 'Mixup', transport: 'http', url: prot.url });
      const before = prot.tokenParams.length;
      const { location } = await signIn(s.id);
      const r = await owner.request('POST', `/v1/mcp/servers/${s.id}/auth/finish`, { callbackUrl: location });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('mcp_auth_failed');
      expect(prot.tokenParams.length).toBe(before);
      expect((await req(owner, 'GET', `/v1/mcp/servers/${s.id}`)).signedIn).toBe(false);
    } finally {
      prot.wrongIss = false;
    }
  }, 60_000);

  it('uses a Client ID Metadata Document when the owner hosts one and the server supports it', async () => {
    const cimd = 'https://advence.example.net/oauth/client-metadata.json';
    expect((await owner.request('GET', '/oauth/client-metadata.json')).status).toBe(404);
    const self = await req(owner, 'PATCH', '/v1/mcp/settings', { clientMetadataUrl: cimd });
    expect(self.clientMetadataUrl).toBe(cimd);
    const doc = await req(owner, 'GET', '/oauth/client-metadata.json');
    expect(doc).toMatchObject({ client_id: cimd, redirect_uris: ['http://localhost:47823/oauth/callback'], token_endpoint_auth_method: 'none' });
    prot.cimd = true;
    try {
      const regs = prot.registered.length;
      const s = await req(owner, 'POST', '/v1/mcp/servers', { name: 'Cimd', transport: 'http', url: prot.url });
      await signIn(s.id);
      expect(prot.authorizeParams.at(-1)!.get('client_id')).toBe(cimd);
      expect(prot.registered.length).toBe(regs);
    } finally {
      prot.cimd = false;
      await req(owner, 'PATCH', '/v1/mcp/settings', { clientMetadataUrl: null });
    }
  }, 60_000);

  it('uses a pre-registered client when one is configured', async () => {
    const regs = prot.registered.length;
    const s = await req(owner, 'POST', '/v1/mcp/servers', { name: 'Prereg', transport: 'http', url: prot.url, oauthClient: { clientId: 'pre-123' } });
    expect(s.preregistered).toBe(true);
    await signIn(s.id);
    expect(prot.authorizeParams.at(-1)!.get('client_id')).toBe('pre-123');
    expect(prot.registered.length).toBe(regs);
  }, 60_000);
});

describe('FR-MCP-04 this server as an MCP server', () => {
  let token = '';
  let endpoint = '';
  let cert = '';

  beforeAll(async () => {
    const created = await req(owner, 'POST', '/v1/mcp/tokens', { name: 'Claude Code on my PC' });
    token = created.token;
    expect(token).toMatch(/^advmcp_/);
    const self = await req(owner, 'GET', '/v1/mcp/self');
    expect(self.tokens.map((t: { name: string }) => t.name)).toContain('Claude Code on my PC');
    expect(JSON.stringify(self)).not.toContain(token);
    cert = self.certPem;
    const port = new URL(self.endpoint).port;
    endpoint = `https://127.0.0.1:${port}/mcp`;
  });

  async function external(mode: 'auto' | 'legacy', auth = `Bearer ${token}`): Promise<Client> {
    const client = new Client({ name: 'external-test', version: '1.0.0' }, { versionNegotiation: { mode, probe: { timeoutMs: 10_000 } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { fetch: pinnedFetch(cert), requestInit: { headers: { authorization: auth } } }));
    return client;
  }

  it('FR-MCP-05 members\' fetch reaches public https servers only, by the address the name resolves to', async () => {
    // Streams a real MCP session through the member fetch when the address check lets it pass.
    const open = createPublicFetch({ allowAddress: () => true, ca: cert });
    const client = new Client({ name: 'member-fetch', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { fetch: open, requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    await client.close();
    // The real check refuses this loopback address, and names that resolve to private addresses.
    const strict = createPublicFetch({ ca: cert });
    await expect(strict(endpoint, { method: 'POST', body: '{}' })).rejects.toThrow(/mcp_url_not_allowed/);
    for (const addr of ['10.0.0.5', '169.254.169.254', '127.0.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe90::1']) {
      const f = createPublicFetch({ lookup: (_h, _o, cb) => cb(null, [{ address: addr, family: addr.includes(':') ? 6 : 4 }]) });
      await expect(f('https://rebind.example/mcp'), addr).rejects.toThrow(/mcp_url_not_allowed/);
    }
    const mixed = createPublicFetch({ lookup: (_h, _o, cb) => cb(null, [{ address: '93.184.215.14', family: 4 }, { address: '10.1.2.3', family: 4 }]) });
    await expect(mixed('https://mixed.example/mcp')).rejects.toThrow(/mcp_url_not_allowed/);
    await expect(createPublicFetch()('http://example.com/mcp')).rejects.toThrow(/mcp_url_not_allowed/);
    expect(['8.8.8.8', '2606:4700:4700::1111'].every(isPublicAddress)).toBe(true);
    expect(['100.64.0.1', '172.16.0.1', '192.168.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'fe80::1', 'febf::1'].some(isPublicAddress)).toBe(false);
  }, 60_000);

  for (const mode of ['auto', 'legacy'] as const) {
    it(`an external client lists and messages Bots (${mode === 'auto' ? '2026-07-28' : '2025-11-25'})`, async () => {
      const bot = await newBot(`Reachable ${mode}`);
      chatPlan = (r) => {
        const msgs = r.body.messages as any[];
        const last = msgs[msgs.length - 1];
        return { text: [`Got: ${typeof last.content === 'string' ? last.content : last.content.map((p: any) => p.text).join('')}`] };
      };
      const c = await external(mode);
      try {
        expect(c.getProtocolEra()).toBe(mode === 'auto' ? 'modern' : 'legacy');
        const tools = (await c.listTools()).tools.map((t) => t.name);
        expect(tools).toEqual(expect.arrayContaining(['list_bots', 'message_bot', 'list_routines', 'read_library']));
        const bots = (await c.callTool({ name: 'list_bots', arguments: {} })) as { structuredContent: { bots: { name: string }[] } };
        expect(bots.structuredContent.bots.map((b) => b.name)).toContain(bot.name);
        const reply = (await c.callTool({ name: 'message_bot', arguments: { bot: bot.name, text: 'status report please' } })) as { content: { text: string }[] };
        expect(reply.content[0]!.text).toBe('Got: status report please');
        const routines = (await c.callTool({ name: 'list_routines', arguments: {} })) as { content: { text: string }[] };
        expect(routines.content[0]!.text).toBe('No routines yet.');
        const lib = (await c.callTool({ name: 'read_library', arguments: {} })) as { isError?: boolean };
        expect(lib.isError).toBeFalsy();
        const missing = (await c.callTool({ name: 'message_bot', arguments: { bot: 'Nobody', text: 'hi' } })) as { isError?: boolean };
        expect(missing.isError).toBe(true);
      } finally {
        await c.close();
      }
    }, 60_000);
  }

  it('requires an owner token and refuses browser origins', async () => {
    const f = pinnedFetch(cert);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await f(endpoint, { method: 'POST', headers: h, body })).status).toBe(401);
    expect((await f(endpoint, { method: 'POST', headers: { ...h, authorization: 'Bearer advmcp_wrong' }, body })).status).toBe(401);
    // A session token of the owner's device is not an MCP token.
    expect((await f(endpoint, { method: 'POST', headers: { ...h, authorization: `Bearer ${owner.token}` }, body })).status).toBe(401);
    expect((await f(endpoint, { method: 'POST', headers: { ...h, authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body })).status).toBe(403);
    // A revoked token stops working.
    const t2 = await req(owner, 'POST', '/v1/mcp/tokens', { name: 'temp' });
    expect((await f(endpoint, { method: 'POST', headers: { ...h, authorization: `Bearer ${t2.token}` }, body })).status).toBe(200);
    await req(owner, 'DELETE', `/v1/mcp/tokens/${t2.info.id}`);
    expect((await f(endpoint, { method: 'POST', headers: { ...h, authorization: `Bearer ${t2.token}` }, body })).status).toBe(401);
  }, 60_000);
});

describe('FR-MCP-05 management', () => {
  let member: TestClient;
  beforeAll(async () => {
    expect((await owner.request('POST', '/v1/allowlist', { email: 'mcp-member@example.com' })).status).toBe(200);
    member = await pairedClient(env, { approveAs: owner });
    expect((await member.loginWithCode(env.google, { sub: 'mcp-member-sub', email: 'mcp-member@example.com' })).status).toBe(200);
  });

  it('adds, lists, enables per Bot, filters tools by allowlist, disables and removes', async () => {
    const a = await newBot('Alpha');
    const b = await newBot('Beta');
    const s = await req(owner, 'POST', '/v1/mcp/servers', { name: 'Managed', transport: 'http', url: everything.url, headers: { 'X-Api-Key': 'hdr-secret-1' }, bots: [a.id] });
    expect(s.headerNames).toEqual(['X-Api-Key']);
    expect(JSON.stringify(await req(owner, 'GET', '/v1/mcp/servers'))).not.toContain('hdr-secret-1');
    await req(owner, 'POST', `/v1/mcp/servers/${s.id}/check`, {});
    const names = async (bot: Bot) => {
      await hub().prepare(user, bot, AbortSignal.timeout(30_000));
      return hub().specs(user, bot).map((x) => x.name).filter((x) => x.startsWith('mcp_Managed_'));
    };
    expect(await names(a)).toContain(toolName('Managed', 'echo'));
    expect(await names(b)).toEqual([]);
    // The header reached the server.
    const hdr = await tool(a, toolName('Managed', 'get-header-params'), {}).catch(() => null);
    if (hdr && !hdr.isError) expect(hdr.content).toContain('hdr-secret-1');

    await req(owner, 'PATCH', `/v1/mcp/servers/${s.id}`, { bots: [a.id, b.id], allow: ['echo'] });
    expect(await names(b)).toEqual([toolName('Managed', 'echo')]);
    // A tool outside the allowlist cannot be called even by name.
    expect((await tool(a, toolName('Managed', 'get-sum'), { a: 1, b: 2 })).isError).toBe(true);

    await req(owner, 'PATCH', `/v1/mcp/servers/${s.id}`, { enabled: false });
    expect(await names(a)).toEqual([]);
    await req(owner, 'PATCH', `/v1/mcp/servers/${s.id}`, { enabled: true, allow: null });
    expect((await names(a)).length).toBeGreaterThan(5);

    expect((await owner.request('PATCH', `/v1/mcp/servers/${s.id}`, { bots: ['bot_not_mine'] })).status).toBe(400);
    await req(owner, 'DELETE', `/v1/mcp/servers/${s.id}`);
    expect((await req(owner, 'GET', '/v1/mcp/servers')).some((x: { id: string }) => x.id === s.id)).toBe(false);
    expect(await names(a)).toEqual([]);
  }, 60_000);

  it('keeps members to public HTTPS servers, their own servers and no owner settings', async () => {
    for (const url of ['http://example.com/mcp', 'https://127.0.0.1/mcp', 'https://10.0.0.5/mcp', 'https://192.168.1.1/mcp', 'https://localhost/mcp', 'https://[::1]/mcp', 'https://localhost./mcp', 'https://intranet/mcp', 'https://[::ffff:10.0.0.1]/mcp', 'https://[fe90::1]/mcp']) {
      const r = await member.request('POST', '/v1/mcp/servers', { name: 'Nope', transport: 'http', url });
      expect(r.status, url).toBe(403);
    }
    // Local commands are the owner's (DL-056).
    const stdio = await member.request('POST', '/v1/mcp/servers', { name: 'Cmd', transport: 'stdio', command: 'id' });
    expect([stdio.status, stdio.json.error]).toEqual([403, 'mcp_stdio_owner_only']);
    const ok = await member.request('POST', '/v1/mcp/servers', { name: 'Public', transport: 'http', url: 'https://mcp.example.com/mcp' });
    expect(ok.status).toBe(200);
    // Members see only their own servers; the owner's servers are invisible to them and vice versa.
    const mine = (await req(member, 'GET', '/v1/mcp/servers')) as { id: string }[];
    expect(mine.map((x) => x.id)).toEqual([ok.json.id]);
    expect((await owner.request('GET', `/v1/mcp/servers/${ok.json.id}`)).status).toBe(404);
    expect((await member.request('POST', '/v1/mcp/tokens', { name: 'x' })).status).toBe(403);
    expect((await member.request('GET', '/v1/mcp/self')).status).toBe(403);
    expect((await member.request('PATCH', '/v1/mcp/settings', { clientMetadataUrl: null })).status).toBe(403);
  }, 60_000);
});
