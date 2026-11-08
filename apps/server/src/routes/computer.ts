// P3 REST API: Bot computers (FR-PC-01..08), the live view and take-over (FR-UI-05) and the
// Cloud computer settings (FR-UI-07).
import type { FastifyRequest } from 'fastify';
import { ComputerLimitsPatch, ComputerSettingsPatch, type ComputerView } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { parse, router, userOf } from '../http.js';
import type { Chat } from '../chat/index.js';
import type { Computers } from '../computer/index.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;

export function registerComputerRoutes(app: import('fastify').FastifyInstance, ctx: AppContext, chat: Chat, c: Computers): void {
  const route = router(app, ctx);
  const m = c.manager;
  const bot = (req: FastifyRequest) => {
    const user = userOf(req);
    const b = chat.bots.owned(user, params(req).id!);
    return { user, b, ref: { id: b.id, userId: user.id } };
  };

  route('GET', '/v1/bots/:id/computer', 'session', async (req) => {
    const { b } = bot(req);
    await m.runtimeInfo();
    return m.state(b.id);
  });
  route('POST', '/v1/bots/:id/computer/start', 'session', async (req) => {
    const { b, ref, user } = bot(req);
    chat.activity.log(user.id, b.id, 'computer.start', { bot: b.name });
    // Starting can take a while (image build); progress arrives as computer.updated events.
    void m.ensure(ref).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    return m.state(b.id);
  });
  route('POST', '/v1/bots/:id/computer/stop', 'session', async (req) => {
    const { b, ref, user } = bot(req);
    await m.stop(ref);
    chat.activity.log(user.id, b.id, 'computer.stop', { bot: b.name });
    return m.state(b.id);
  });
  route('GET', '/v1/bots/:id/computer/view', 'session', async (req): Promise<ComputerView> => {
    const { b } = bot(req);
    return { password: (await m.vnc(b.id)).password };
  });
  route('POST', '/v1/bots/:id/computer/takeover', 'session', (req) => {
    const { b, ref, user } = bot(req);
    chat.activity.log(user.id, b.id, 'computer.takeover', { bot: b.name });
    return m.takeOver(ref);
  });
  route('POST', '/v1/bots/:id/computer/handback', 'session', (req) => {
    const { b, ref, user } = bot(req);
    chat.activity.log(user.id, b.id, 'computer.handback', { bot: b.name });
    return m.handBack(ref);
  });
  // Resources are the server owner's to hand out (FR-PC-05).
  route('PATCH', '/v1/bots/:id/computer/limits', 'owner', async (req) => {
    const { ref } = bot(req);
    return m.setLimits(ref, parse(ComputerLimitsPatch, req.body));
  });

  route('GET', '/v1/computer/settings', 'session', () => m.settings());
  route('PATCH', '/v1/computer/settings', 'owner', async (req) => {
    m.setSettings(parse(ComputerSettingsPatch, req.body));
    return m.settings();
  });
  route('POST', '/v1/computer/image', 'owner', async () => {
    void m.buildImage(true).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    return m.settings();
  });
}
