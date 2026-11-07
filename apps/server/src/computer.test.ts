// P3 Bot computers (FR-PC-01..09, FR-UI-05, NFR-SEC-08) against an in-memory container runtime,
// plus the Podman command lines the real runtime would run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalFrame, newNonce, sign, toB64url, COMPUTER_EVENTS, COMPUTER_WS_PATH } from '@advence/protocol';
import { startTestServer, ownerClient, pairedClient, type TestClient, type TestEnv } from './test-utils/harness.js';
import { MockModels, type SeenRequest } from './test-utils/mock-models.js';
import { FakeRuntime, FAKE_JPEG } from './test-utils/fake-runtime.js';
import { LocalHost } from './models/host.js';
import { fakeCliDir } from './test-utils/mock-models.js';
import { containerName } from './computer/manager.js';
import { networkArgs, PodmanRuntime } from './computer/runtime.js';
import { toSendKeys, windowsScript, x11Script } from './computer/actions.js';
import type { BusEvent } from './events.js';

let models: MockModels;
let rt: FakeRuntime;
let env: TestEnv;
let owner: TestClient;
let events: BusEvent[] = [];
const cid = () => `c-${Math.random().toString(36).slice(2, 12)}`;

async function req(c: TestClient, method: string, url: string, body?: unknown): Promise<any> {
  const r = await c.request(method, url, body);
  expect(r.status, `${method} ${url} ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
}
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Chat model: call `tool` with `input` once, then answer with what the tool returned. */
function toolScript(tool: string, input: unknown) {
  return (r: SeenRequest) => {
    const msgs = r.body.messages as any[];
    const result = msgs.find((m) => m.role === 'tool');
    if (result) return { text: [`Tool said: ${result.content}`] };
    return { tool: { name: tool, input } };
  };
}

beforeAll(async () => {
  models = await MockModels.start();
  rt = await FakeRuntime.start();
  env = await startTestServer({ boot: { modelFetch: models.fetch, containerRuntime: rt, processHost: new LocalHost({ binDir: fakeCliDir() }) } });
  env.server.ctx.bus.subscribe((e) => void events.push(e));
  owner = await ownerClient(env);
});
afterAll(async () => {
  await env.close();
  await models.close();
  rt.close();
});

describe('FR-PC-01 one computer per Bot', () => {
  it('a new Bot gets a running computer within 60 s, isolated per NFR-SEC-08', async () => {
    const t0 = Date.now();
    const b = await req(owner, 'POST', '/v1/bots', { name: 'Builder' });
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    expect(Date.now() - t0).toBeLessThan(60_000);
    const spec = rt.created.find((s) => s.labels['advence.bot'] === b.id)!;
    expect(spec.name).toBe(containerName(b.id));
    expect(spec.volume).toBe(`advence-bot-${b.id}-home`);
    // No route to the host (pasta without the gateway mapping); no local model ports to forward yet.
    expect(spec.network).toEqual(['--network', 'pasta:--no-map-gw']);
    expect(spec.cpus).toBe(2);
    expect(spec.memoryMb).toBe(3072);
    // The VNC password is a per-Bot secret, never in the image or the command line.
    expect(rt.secrets.get(spec.vncSecret)).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(events.some((e) => e.event === COMPUTER_EVENTS.computerUpdated && (e.data as any).state === 'running')).toBe(true);
  });

  it('FR-PC-03 stop and start keep the same home volume; new limits re-create the container on the same volume', async () => {
    const b = await req(owner, 'POST', '/v1/bots', { name: 'Keeper' });
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    fs.writeFileSync(path.join(rt.home(containerName(b.id)), 'notes.txt'), 'keep me');
    expect((await req(owner, 'POST', `/v1/bots/${b.id}/computer/stop`)).state).toBe('stopped');
    await req(owner, 'POST', `/v1/bots/${b.id}/computer/start`);
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    const r = await req(owner, 'PATCH', `/v1/bots/${b.id}/computer/limits`, { cpus: 1, memoryMb: 1024 });
    expect(r.limits).toMatchObject({ cpus: 1, memoryMb: 1024 });
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    const specs = rt.created.filter((s) => s.labels['advence.bot'] === b.id);
    expect(specs).toHaveLength(2);
    expect(specs[1]).toMatchObject({ cpus: 1, memoryMb: 1024, volume: specs[0]!.volume });
    expect(fs.readFileSync(path.join(rt.home(containerName(b.id)), 'notes.txt'), 'utf8')).toBe('keep me');
  });

  it('FR-PC-05 limits: defaults are editable in Settings; a computer over its disk limit is stopped until the limit is raised', async () => {
    expect((await owner.request('PATCH', '/v1/computer/settings', { defaults: { memoryMb: 100 } })).status).toBe(400);
    const s = await req(owner, 'PATCH', '/v1/computer/settings', { defaults: { cpus: 3, memoryMb: 4096, diskGb: 1 } });
    expect(s.defaults).toEqual({ cpus: 3, memoryMb: 4096, diskGb: 1 });
    const b = await req(owner, 'POST', '/v1/bots', { name: 'Hoarder' });
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    expect(rt.created.find((x) => x.labels['advence.bot'] === b.id)).toMatchObject({ cpus: 3, memoryMb: 4096 });
    rt.disk = 2 * 1024 ** 3;
    await env.server.computers.manager.checkDisks();
    rt.disk = 0;
    const st = await req(owner, 'GET', `/v1/bots/${b.id}/computer`);
    expect(st.state).toBe('disk_full');
    expect(rt.containers.get(containerName(b.id))!.running).toBe(false);
    await req(owner, 'POST', `/v1/bots/${b.id}/computer/start`);
    expect((await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state).toBe('disk_full');
    await req(owner, 'PATCH', `/v1/bots/${b.id}/computer/limits`, { diskGb: 5 });
    await req(owner, 'POST', `/v1/bots/${b.id}/computer/start`);
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    await req(owner, 'PATCH', '/v1/computer/settings', { defaults: { cpus: 2, memoryMb: 3072, diskGb: 20 } });
  });

  it('FR-PC-08 the GPU is passed through when a CDI GPU is present', async () => {
    rt.gpuPresent = true;
    await env.server.computers.manager.runtimeInfo(true);
    const b = await req(owner, 'POST', '/v1/bots', { name: 'Gamer' });
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    expect(rt.created.find((x) => x.labels['advence.bot'] === b.id)!.gpu).toBe(true);
    expect((await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).gpu).toBe(true);
    rt.gpuPresent = false;
    await env.server.computers.manager.runtimeInfo(true);
  });

  it('D-07a/NFR-SEC-08 only the loopback ports of local model servers are forwarded, never the server\'s own port', async () => {
    const port = Number(new URL(env.server.url).port);
    env.server.ctx.config.port = port;
    await req(owner, 'POST', '/v1/sources', { kind: 'local', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' });
    await req(owner, 'POST', '/v1/sources', { kind: 'local', name: 'Sneaky', baseUrl: `http://127.0.0.1:${port}/v1` });
    await req(owner, 'POST', '/v1/sources', { kind: 'local', name: 'LAN', baseUrl: 'http://192.168.1.5:8080/v1' });
    const b = await req(owner, 'POST', '/v1/bots', { name: 'Local user' });
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    expect(rt.created.find((x) => x.labels['advence.bot'] === b.id)!.network).toEqual(['--network', 'pasta:--no-map-gw,-T,11434']);
    expect(networkArgs({ available: true, version: '4', error: null, rootless: true, pasta: false }, [])).toEqual({ args: ['--network', 'slirp4netns:allow_host_loopback=false'], isolated: false });
  });
});

describe('FR-PC-06 chat always works', () => {
  it('without a container runtime, and while the image is still building', async () => {
    const src = await req(owner, 'POST', '/v1/sources', { kind: 'openai', name: 'OpenAI', apiKey: 'sk-test-openai-000' });
    const b = await req(owner, 'POST', '/v1/bots', { name: 'Talker', sourceId: src.id, tools: [] });
    const conv = (await req(owner, 'POST', '/v1/conversations/direct', { botId: b.id })).id;
    rt.available = false;
    await env.server.computers.manager.runtimeInfo(true);
    expect((await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state).toBe('unavailable');
    await req(owner, 'POST', `/v1/conversations/${conv}/messages`, { text: 'still there?', clientId: cid() });
    await env.server.chat.runtime.idle();
    let list = await req(owner, 'GET', `/v1/conversations/${conv}/messages`);
    expect(list[list.length - 1]).toMatchObject({ status: 'done', text: 'Echo: still there?' });

    rt.available = true;
    rt.imagePresent = false;
    rt.buildDelayMs = 2000;
    await env.server.computers.manager.runtimeInfo(true);
    (env.server.computers.manager as any).image.present = false;
    const slow = await req(owner, 'POST', '/v1/bots', { name: 'Waiting' });
    await until(async () => (await req(owner, 'GET', `/v1/bots/${slow.id}/computer`)).state === 'preparing');
    await req(owner, 'POST', `/v1/conversations/${conv}/messages`, { text: 'and now?', clientId: cid() });
    await env.server.chat.runtime.idle();
    list = await req(owner, 'GET', `/v1/conversations/${conv}/messages`);
    expect(list[list.length - 1]).toMatchObject({ status: 'done', text: 'Echo: and now?' });
    expect((await req(owner, 'GET', `/v1/bots/${slow.id}/computer`)).state).toBe('preparing');
    await until(async () => (await req(owner, 'GET', `/v1/bots/${slow.id}/computer`)).state === 'running', 10_000);
    rt.buildDelayMs = 0;
  });
});

describe('FR-UI-05 live view, take-over and hand-back', () => {
  async function view(c: TestClient, botId: string): Promise<WebSocket> {
    const ws = new WebSocket(c.url.replace('https://', 'wss://') + COMPUTER_WS_PATH, { agent: c.agent() });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const ts = Date.now();
    const nonce = newNonce();
    const payload = JSON.stringify({ token: c.token, botId });
    const sig = toB64url(sign(c.key.secretKey, canonicalFrame({ deviceId: c.deviceId, ts, nonce, type: 'computer.auth', payload })));
    ws.send(JSON.stringify({ type: 'auth', deviceId: c.deviceId, token: c.token, botId, ts, nonce, sig }));
    return ws;
  }

  it('relays the desktop stream to the Bot\'s owner over the signed connection, and to nobody else', async () => {
    const b = await req(owner, 'POST', '/v1/bots', { name: 'Viewer' });
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    const pw = await req(owner, 'GET', `/v1/bots/${b.id}/computer/view`);
    expect(pw.password).toBe(rt.secrets.get(`${containerName(b.id)}-vnc`));

    const ws = await view(owner, b.id);
    const got: string[] = [];
    ws.on('message', (m) => got.push(m.toString()));
    await until(() => got.some((g) => g.includes('ready')));
    ws.send(Buffer.from('RFB 003.008\n').toString('base64'));
    await until(() => got.some((g) => !g.startsWith('{') && Buffer.from(g, 'base64').toString() === 'echo:RFB 003.008\n'));
    ws.close();

    // A member cannot open the owner's Bot computer.
    expect((await owner.request('POST', '/v1/allowlist', { email: 'member2@example.com' })).status).toBe(200);
    const m = await pairedClient(env);
    expect((await m.loginWithCode(env.google, { sub: 'member2', email: 'member2@example.com' })).status).toBe(200);
    expect((await m.request('GET', `/v1/bots/${b.id}/computer`)).status).toBe(404);
    expect((await m.request('POST', `/v1/bots/${b.id}/computer/takeover`)).status).toBe(404);
    const bad = await view(m, b.id);
    const code = await new Promise<number>((r) => bad.on('close', (c) => r(c)));
    expect(code).toBe(4001);
    // A forged signature is refused too.
    const forged = new WebSocket(owner.url.replace('https://', 'wss://') + COMPUTER_WS_PATH, { agent: owner.agent() });
    await new Promise((r) => forged.once('open', r));
    forged.send(JSON.stringify({ type: 'auth', deviceId: owner.deviceId, token: owner.token, botId: b.id, ts: Date.now(), nonce: newNonce(), sig: toB64url(new Uint8Array(64)) }));
    expect(await new Promise<number>((r) => forged.on('close', (c) => r(c)))).toBe(4001);
  });

  it('the Bot\'s computer actions wait while the owner has taken over, and continue after hand-back', async () => {
    const src = await req(owner, 'POST', '/v1/sources', { kind: 'openai', name: 'OpenAI 2', apiKey: 'sk-test-openai-001' });
    const b = await req(owner, 'POST', '/v1/bots', { name: 'Clicker', sourceId: src.id });
    await until(async () => (await req(owner, 'GET', `/v1/bots/${b.id}/computer`)).state === 'running');
    const conv = (await req(owner, 'POST', '/v1/conversations/direct', { botId: b.id })).id;
    expect((await req(owner, 'POST', `/v1/bots/${b.id}/computer/takeover`)).takeover).toBe(true);
    fs.rmSync(rt.inputLog, { force: true });
    models.script = toolScript('computer', { action: 'click', x: 10, y: 20 });
    await req(owner, 'POST', `/v1/conversations/${conv}/messages`, { text: 'click it', clientId: cid() });
    await new Promise((r) => setTimeout(r, 500));
    // Nothing reached the desktop while the owner had it.
    expect(fs.existsSync(rt.inputLog)).toBe(false);
    expect((await req(owner, 'POST', `/v1/bots/${b.id}/computer/handback`)).takeover).toBe(false);
    await env.server.chat.runtime.idle();
    expect(fs.readFileSync(rt.inputLog, 'utf8')).toContain('xdotool mousemove --sync 10 20 click --repeat 1 1');
    const list = await req(owner, 'GET', `/v1/conversations/${conv}/messages`);
    expect(list[list.length - 1].text).toBe('Tool said: click done.');
    // The screenshot went back to the model with the tool result.
    // (the learn pass that follows a task is a separate, later request)
    const last = models.requests.filter((r) => !JSON.stringify(r.body).includes('learn pass')).pop()!.body.messages as any[];
    const img = last.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).find((p: any) => p.type === 'image_url');
    expect(img.image_url.url).toBe(`data:image/jpeg;base64,${FAKE_JPEG.toString('base64')}`);
  });
});

describe('FR-PC-09 Host control (D-12)', () => {
  it('is off by default and blocked when off; only the owner can turn it on; when on, the Bot drives the host desktop', async () => {
    const src = await req(owner, 'POST', '/v1/sources', { kind: 'openai', name: 'OpenAI 3', apiKey: 'sk-test-openai-002' });
    const b = await req(owner, 'POST', '/v1/bots', { name: 'Operator', sourceId: src.id, tools: ['host'] });
    expect(b.hostControl).toBe(false);
    const conv = (await req(owner, 'POST', '/v1/conversations/direct', { botId: b.id })).id;
    models.requests = [];
    models.script = toolScript('host', { action: 'key', keys: 'ctrl+l' });
    await req(owner, 'POST', `/v1/conversations/${conv}/messages`, { text: 'go', clientId: cid() });
    await env.server.chat.runtime.idle();
    expect((models.requests[0]!.body.tools ?? []).map((t: any) => t.function.name)).not.toContain('host');
    let list = await req(owner, 'GET', `/v1/conversations/${conv}/messages`);
    expect(list[list.length - 1].text).toBe('Tool said: Host control is off for this Bot.');

    const m = await pairedClient(env);
    expect((await owner.request('POST', '/v1/allowlist', { email: 'member3@example.com' })).status).toBe(200);
    expect((await m.loginWithCode(env.google, { sub: 'member3', email: 'member3@example.com' })).status).toBe(200);
    const mine = await req(m, 'POST', '/v1/bots', { name: 'Mine', tools: ['host'] });
    expect((await m.request('PATCH', `/v1/bots/${mine.id}`, { hostControl: true })).json.error).toBe('owner_only');

    await req(owner, 'PATCH', `/v1/bots/${b.id}`, { hostControl: true });
    const saved = { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
    process.env.PATH = `${rt.bin}:${process.env.PATH}`;
    process.env.DISPLAY = ':99';
    delete process.env.WAYLAND_DISPLAY;
    fs.rmSync(rt.inputLog, { force: true });
    try {
      models.requests = [];
      await req(owner, 'POST', `/v1/conversations/${conv}/messages`, { text: 'go again', clientId: cid() });
      await env.server.chat.runtime.idle();
    } finally {
      Object.assign(process.env, saved);
      if (saved.WAYLAND_DISPLAY === undefined) delete process.env.WAYLAND_DISPLAY;
      if (saved.DISPLAY === undefined) delete process.env.DISPLAY;
    }
    expect((models.requests[0]!.body.tools ?? []).map((t: any) => t.function.name)).toContain('host');
    expect(fs.readFileSync(rt.inputLog, 'utf8')).toContain('xdotool key -- ctrl+l');
    list = await req(owner, 'GET', `/v1/conversations/${conv}/messages`);
    expect(list[list.length - 1].text).toBe('Tool said: key done.');
  });

  it('builds safe commands for each OS: values travel in the environment, keys are mapped', () => {
    const t = x11Script({ action: 'type', text: '"; rm -rf / #' });
    expect(t.script).not.toContain('rm -rf');
    expect(t.env.ATEXT).toBe('"; rm -rf / #');
    const w = windowsScript({ action: 'type', text: 'a+b' });
    expect(w.script).not.toContain('a+b');
    expect(toSendKeys('ctrl+l Return')).toBe('^l{ENTER}');
    expect(toSendKeys('ctrl+shift+t')).toBe('^+t');
  });
});

describe('NFR-SEC-08 Podman command lines', () => {
  it('create: non-root image, no new privileges, all capabilities dropped but CAP_SYS_CHROOT, default seccomp, only the Bot volume, noVNC on loopback; exec passes secrets by name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-podman-'));
    const fake = path.join(dir, 'podman');
    fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/argv"\nprintf '%s' "$SECRET_TOKEN" > "${dir}/env"\n`, { mode: 0o755 });
    const p = new PodmanRuntime(fake);
    await p.create({ name: 'advence-bot-x', image: 'localhost/img:1', volume: 'advence-bot-x-home', vncSecret: 's', cpus: 2, memoryMb: 2048, gpu: false, network: ['--network', 'pasta:--no-map-gw'], labels: { 'advence.bot': 'x' } });
    const argv = fs.readFileSync(path.join(dir, 'argv'), 'utf8').trim().split('\n');
    expect(argv).toEqual(expect.arrayContaining(['--security-opt', 'no-new-privileges', '--cap-drop', 'all', '--cap-add', 'SYS_CHROOT', '--cpus', '2', '--memory', '2048m', '-p', '127.0.0.1::6080', '--network', 'pasta:--no-map-gw']));
    expect(argv.filter((a) => a === '-v')).toHaveLength(1);
    expect(argv[argv.indexOf('-v') + 1]).toBe('advence-bot-x-home:/home/bot');
    for (const bad of ['--privileged', 'seccomp=unconfined', '--no-sandbox', 'podman.sock', '--userns=host', '--pid=host', '--network=host']) expect(argv.join(' ')).not.toContain(bad);
    const run = p.exec('advence-bot-x', ['codex', 'exec'], { env: { SECRET_TOKEN: 'sk-very-secret', 'bad name': 'x' }, signal: new AbortController().signal });
    await run.done;
    const ex = fs.readFileSync(path.join(dir, 'argv'), 'utf8').trim().split('\n');
    expect(ex.join(' ')).not.toContain('sk-very-secret');
    expect(ex).toEqual(['exec', '-i', '-e', 'SECRET_TOKEN', 'advence-bot-x', 'codex', 'exec']);
    expect(fs.readFileSync(path.join(dir, 'env'), 'utf8')).toBe('sk-very-secret');
  });
});
