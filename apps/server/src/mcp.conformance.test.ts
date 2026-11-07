// FR-MCP-02/03: the official MCP conformance suite (client scenarios) against the real McpHub, for
// both spec revisions. The framework runs a small relay as the "client"; the relay hands each
// scenario to this process, which adds the scenario's server in Settings the way a user would,
// signs in when asked (the test authorization servers approve at once), lists and calls tools,
// answers input requests and then removes the server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Bot, McpInput, McpServer, User } from '@advence/protocol';
import { startTestServer, ownerClient, type TestClient, type TestEnv } from './test-utils/harness.js';
import { setMeta } from './db.js';
import { toolName, type McpHub } from './mcp/hub.js';
import { HttpError } from './http.js';

const require = createRequire(import.meta.url);
const CIMD_URL = 'https://conformance-test.local/client-metadata.json';
const REDIRECT = 'http://localhost:47823/oauth/callback';

let env: TestEnv;
let owner: TestClient;
let user: User;
let src = '';
let control: http.Server;
let controlUrl = '';
let hub: McpHub;
let n = 0;

async function newBot(name: string): Promise<Bot> {
  const b = (await owner.request('POST', '/v1/bots', { name, sourceId: src })).json;
  return env.server.chat.bots.get(b.id)!;
}

/** Values for a tool's or form's required fields, from its JSON schema. */
function sample(schema: { properties?: Record<string, any>; required?: string[] } | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of schema?.required ?? []) {
    const p = schema?.properties?.[k] ?? {};
    if (p.default !== undefined) out[k] = p.default;
    else if (p.enum) out[k] = p.enum[0];
    else if (p.oneOf) out[k] = p.oneOf[0]?.const;
    else if (p.type === 'number' || p.type === 'integer') out[k] = 1;
    else if (p.type === 'boolean') out[k] = true;
    else if (p.type === 'array') out[k] = [];
    else if (p.type === 'object') out[k] = {};
    else out[k] = 'test';
  }
  return out;
}

/** The user's browser: open the authorization URL and follow redirects until the app's callback. */
async function browse(url: string): Promise<string> {
  let at = url;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(at, { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (!loc) throw new Error(`authorization stopped at ${r.status}`);
    const next = new URL(loc, at).href;
    if (next.startsWith(REDIRECT)) return next;
    at = next;
  }
  throw new Error('too many redirects');
}

async function signInIfAsked(id: string, log: string[]): Promise<boolean> {
  const url = hub.authUrl(user, id);
  if (!url) return false;
  log.push(`sign-in: ${url.split('?')[0]}`);
  const cb = await browse(url);
  await hub.finishAuth(user, id, { callbackUrl: cb });
  return true;
}

async function connect(id: string, log: string[]): Promise<McpServer> {
  for (let i = 0; i < 4; i++) {
    try {
      const s = await hub.check(user, id);
      if (s.status === 'ok') return s;
    } catch (e) {
      if (!(e instanceof HttpError) || e.code !== 'mcp_auth_required') throw e;
    }
    if (!(await signInIfAsked(id, log))) break;
  }
  return hub.check(user, id);
}

async function call(bot: Bot, name: string, input: unknown, id: string, log: string[]): Promise<{ content: string; isError?: boolean }> {
  for (let i = 0; i < 3; i++) {
    const signal = AbortSignal.timeout(20_000);
    await hub.prepare(user, bot, signal);
    hub.specs(user, bot);
    const r = (await hub.run({ user, bot, convId: 'conformance', messageId: 'm', signal }, { id: `c${i}`, name, input })) as { content: string; isError?: boolean };
    // Step-up: the server asked for more scope mid-call; the user signs in again and the Bot retries.
    if (r.isError && (await signInIfAsked(id, log))) continue;
    return r;
  }
  throw new Error('sign-in loop');
}

async function runScenario(url: string, scenario: string, context: Record<string, any>): Promise<string[]> {
  const log: string[] = [];
  const name = `conf${++n}`;
  // Scenarios run in parallel; each gets its own Bot, as separate users' Bots would.
  const bot = await newBot(name);
  const created = hub.create(user, {
    name,
    transport: 'http',
    url,
    bots: [bot.id],
    allow: null,
    ...(context.client_id ? { oauthClient: { clientId: context.client_id, ...(context.client_secret ? { clientSecret: context.client_secret } : {}) } } : {}),
  });
  try {
    const s = await connect(created.id, log);
    log.push(`connected: ${s.era}, ${s.tools.length} tools`);
    await hub.prepare(user, bot, AbortSignal.timeout(20_000));
    const specs = hub.specs(user, bot);
    const planned: { name: string; arguments: Record<string, unknown> }[] = Array.isArray(context.toolCalls)
      ? context.toolCalls
      : s.tools.map((t) => ({ name: t.name, arguments: sample(specs.find((x) => x.name === toolName(name, t.name))?.parameters as never) }));
    for (const t of planned) {
      const spec = specs.find((x) => x.name === toolName(name, t.name));
      if (!spec) {
        log.push(`not offered: ${t.name}`);
        continue;
      }
      const r = await call(bot, spec.name, t.arguments ?? {}, created.id, log);
      log.push(`${t.name}: ${r.isError ? 'error ' : ''}${r.content.slice(0, 120)}`);
    }
    if (s.resources) {
      const list = await call(bot, 'mcp_resources', { server: name }, created.id, log);
      const uri = list.content.split('\n')[0]?.split('\t')[1];
      if (uri) await call(bot, 'mcp_read_resource', { server: name, uri }, created.id, log);
    }
    if (s.prompts) {
      const list = await call(bot, 'mcp_prompts', { server: name }, created.id, log);
      const p = list.content.split('\n')[0]?.split('\t')[1]?.split(' ')[0];
      if (p) await call(bot, 'mcp_get_prompt', { server: name, name: p }, created.id, log);
    }
  } finally {
    await hub.remove(user, created.id);
  }
  return log;
}

beforeAll(async () => {
  env = await startTestServer();
  owner = await ownerClient(env);
  const uid = (env.server.ctx.db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id;
  user = env.server.ctx.identity.getUser(uid)!;
  src = (await owner.request('POST', '/v1/sources', { kind: 'openai', name: 'OpenAI', apiKey: 'sk-test-conformance' })).json.id;
  hub = env.server.mcp.hub;
  // The owner hosts the client metadata document at the URL the conformance suite expects.
  setMeta(env.server.ctx.db, 'mcp.clientMetadataUrl', CIMD_URL);
  // The user answers every input request with the form's defaults (and samples for the rest).
  env.server.ctx.bus.subscribe((ev) => {
    if (ev.userId !== user.id || ev.event !== 'mcp.input' || (ev.data as { done?: boolean }).done) return;
    const i = ev.data as McpInput;
    setTimeout(() => {
      try {
        hub.inputs.answer(user.id, i.id, i.mode === 'form' ? { action: 'accept', content: sample({ ...(i.schema as object), required: ((i.schema?.required ?? []) as string[]).filter((k) => (i.schema as any)?.properties?.[k]?.default === undefined) }) as never } : { action: 'accept' });
      } catch {
        /* already answered */
      }
    }, 10);
  });
  control = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const b = JSON.parse(raw) as { url: string; scenario: string; context: string | null };
    let out: { ok: boolean; log: string };
    try {
      const log = await runScenario(b.url, b.scenario, b.context ? JSON.parse(b.context) : {});
      out = { ok: true, log: log.join('\n') };
    } catch (e) {
      out = { ok: false, log: `${b.scenario}: ${(e as Error).message}` };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  await new Promise<void>((r) => control.listen(0, '127.0.0.1', () => r()));
  controlUrl = `http://127.0.0.1:${(control.address() as { port: number }).port}/`;
}, 60_000);

afterAll(async () => {
  control?.close();
  await env?.close();
});

function conformance(revision: string): Promise<{ code: number; out: string; dir: string }> {
  const bin = path.join(path.dirname(require.resolve('@modelcontextprotocol/conformance/package.json')), 'dist', 'index.js');
  const relay = path.join(__dirname, 'test-utils', 'conformance-relay.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-conformance-'));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, 'client', '--command', `${process.execPath} ${relay}`, '--requirements', revision, '-o', dir], {
      env: { ...process.env, ADVENCE_CONFORMANCE_CONTROL: controlUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code: code ?? 1, out, dir }));
  });
}

describe('FR-MCP-02 MCP conformance suite, client scenarios', () => {
  for (const revision of ['2026-07-28', '2025-11-25']) {
    it(`passes every client scenario required by ${revision}`, async () => {
      const r = await conformance(revision);
      if (r.code !== 0) console.log(r.out.slice(-20_000));
      expect(r.code).toBe(0);
    }, 600_000);
  }
});
