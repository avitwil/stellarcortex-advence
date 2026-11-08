// P7 non-functional checks on the server: first token latency (NFR-PERF-01), ten Bots with
// running computers at once (NFR-PERF-02, scaled; the 32 GB / 8-core host run is
// MC-P7-PERF-10BOTS) and kill-and-restart recovery of chats, routines, triggers and computers
// (NFR-REL-01; the client side is in apps/ui/src/api/socket.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAT_EVENTS, type Routine, type RoutineRun } from '@advence/protocol';
import { startTestServer, ownerClient, type TestClient, type TestEnv } from './test-utils/harness.js';
import { MockModels } from './test-utils/mock-models.js';
import { FakeRuntime } from './test-utils/fake-runtime.js';
import { containerName } from './computer/manager.js';

let models: MockModels;
let rt: FakeRuntime;
let env: TestEnv;
let owner: TestClient;
let sourceId = '';

async function boot(dataDir?: string, unlockDir?: string): Promise<void> {
  env = await startTestServer({ dataDir, unlockDir, boot: { containerRuntime: rt, modelFetch: models.fetch, testHooks: { manualTriggers: true } } });
}
async function req(method: string, p: string, body?: unknown): Promise<any> {
  const r = await owner.request(method, p, body);
  expect(r.status, `${method} ${p} ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
}
const until = async (f: () => Promise<boolean> | boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const cid = () => `c-${Math.random().toString(36).slice(2, 12)}`;

beforeAll(async () => {
  models = await MockModels.start();
  rt = await FakeRuntime.start();
  await boot();
  owner = await ownerClient(env);
  sourceId = (await req('POST', '/v1/sources', { kind: 'openai', name: 'OpenAI', apiKey: 'sk-test-nfr' })).id;
});
afterAll(async () => {
  await env.close();
  await models.close();
});

describe('NFR-PERF-01 first token streams to the UI within 1 s after the model starts sending', () => {
  it('the first delta reaches the signed WebSocket well within 1 s, while the model keeps streaming', async () => {
    const bot = await req('POST', '/v1/bots', { name: 'Quick', sourceId });
    const conv = (await req('POST', '/v1/conversations/direct', { botId: bot.id })).id;
    const ws = await owner.ws();
    ws.auth();
    await ws.next((f) => f.type === 'ready');
    const samples: number[] = [];
    models.script = () => ({ text: ['First', ' and the rest'], gapMs: 1500 });
    for (let i = 0; i < 3; i++) {
      ws.frames.length = 0;
      await req('POST', `/v1/conversations/${conv}/messages`, { text: `hello ${i}`, clientId: cid() });
      const delta = await ws.next((f) => f.type === 'event' && f.event === CHAT_EVENTS.messageDelta && f.data.conversationId === conv);
      samples.push(Date.now() - models.firstChunkAt);
      expect(delta.data.text).toBe('First');
      await env.server.chat.runtime.idle();
    }
    ws.close();
    // The model holds the rest of the reply for 1.5 s, so the delta cannot be the full reply.
    expect(Math.max(...samples)).toBeLessThan(1000);
  });
});

describe('NFR-PERF-02 ten Bots with running computers (scaled)', () => {
  it('ten Bots get running computers and all answer concurrently', async () => {
    models.script = (r) => ({ text: ['Done: ', String(r.body.messages.at(-1).content).slice(0, 20)], delayMs: 200 });
    const bots = await Promise.all(Array.from({ length: 10 }, (_, i) => req('POST', '/v1/bots', { name: `Worker ${i}`, sourceId })));
    await until(() => {
      const n = bots.filter((b) => rt.containers.get(containerName(b.id))?.running === true).length;
      return n === 10;
    });
    const convs = await Promise.all(bots.map(async (b) => (await req('POST', '/v1/conversations/direct', { botId: b.id })).id as string));
    const started = Date.now();
    await Promise.all(convs.map((c, i) => req('POST', `/v1/conversations/${c}/messages`, { text: `task ${i}`, clientId: cid() })));
    await env.server.chat.runtime.idle();
    const elapsed = Date.now() - started;
    for (const [i, c] of convs.entries()) {
      const last = (await req('GET', `/v1/conversations/${c}/messages`)).at(-1);
      expect(last).toMatchObject({ status: 'done', text: `Done: task ${i}` });
    }
    // Replies run side by side: ten 200 ms model calls finish far sooner than ten in a row.
    expect(elapsed).toBeLessThan(10 * 200);
    for (const b of bots) await req('DELETE', `/v1/bots/${b.id}`);
  });
});

describe('NFR-REL-01 the server survives restart', () => {
  it('chats, routines, triggers and computers resume after a kill and restart', async () => {
    models.script = () => ({ text: ['Noted.'] });
    const bot = await req('POST', '/v1/bots', { name: 'Keeper', sourceId });
    await req('PATCH', `/v1/bots/${bot.id}`, { proactive: true });
    const conv = (await req('POST', '/v1/conversations/direct', { botId: bot.id })).id;
    await req('POST', `/v1/conversations/${conv}/messages`, { text: 'remember this', clientId: cid() });
    await env.server.chat.runtime.idle();
    const sched: Routine = await req('POST', '/v1/routines', { botId: bot.id, name: 'Hourly', instructions: 'Check in', trigger: { kind: 'schedule', cron: '0 * * * *', tz: 'UTC' } });
    const hook: Routine = await req('POST', '/v1/routines', { botId: bot.id, name: 'Hook', instructions: 'Handle the hook', trigger: { kind: 'webhook' } });
    await until(() => rt.containers.get(containerName(bot.id))?.running === true);

    // Kill: the server goes away and the host reboots (containers stop).
    const { dataDir, unlockDir } = env;
    await env.close();
    for (const c of rt.containers.values()) c.running = false;
    await boot(dataDir, unlockDir);
    owner.url = env.server.url;
    if ((await owner.request('GET', '/v1/me')).status !== 200) await owner.loginWithCode(env.google, { sub: 'owner-sub', email: 'owner@example.com' });

    // Chats are still there.
    const msgs = await req('GET', `/v1/conversations/${conv}/messages`);
    expect(msgs.map((m: { text: string }) => m.text)).toEqual(['remember this', 'Noted.']);
    // Computers come back by themselves.
    await until(() => rt.containers.get(containerName(bot.id))?.running === true);
    // A schedule that came due while the server was down runs once, then moves on.
    const listed: Routine[] = (await req('GET', '/v1/routines')).routines;
    expect(listed.find((r) => r.id === sched.id)?.nextRun).toBe(sched.nextRun);
    const real = env.server.proactive.now;
    try {
      env.server.proactive.now = () => sched.nextRun! + 60_000;
      await env.server.proactive.tick();
      await env.server.proactive.idle();
    } finally {
      env.server.proactive.now = real;
    }
    const runs: RoutineRun[] = (await req('GET', `/v1/routines/runs?routineId=${sched.id}`)).runs;
    expect(runs.map((r) => r.status)).toEqual(['done']);
    expect((await req('GET', '/v1/routines')).routines.find((r: Routine) => r.id === sched.id).nextRun).toBe(sched.nextRun! + 3_600_000);
    // The webhook address made before the restart still starts its routine.
    const url = new URL(hook.webhookUrl!);
    const res = await owner.request('POST', url.pathname, {}, { sign: false, token: '' });
    expect(res.status).toBe(200);
    await env.server.proactive.idle();
    expect((await req('GET', `/v1/routines/runs?routineId=${hook.id}`)).runs[0]).toMatchObject({ status: 'done', trigger: 'webhook' });
  });
});
