// Feature modules added phase by phase register their routes and WS handlers here.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import type { WsGateway } from './ws.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerBrowserUi } from './browser-ui.js';
import { registerChatRoutes } from './routes/chat.js';
import { createChat, type Chat } from './chat/index.js';
import { createComputers, type Computers } from './computer/index.js';
import type { ContainerRuntime } from './computer/runtime.js';
import { registerComputerRoutes } from './routes/computer.js';
import { COMPUTER_WS_PATH } from '@advence/protocol';
import { createMemory, type MemoryServices } from './memory/index.js';
import type { InstallDeps } from './memory/install.js';
import { registerMemoryRoutes } from './routes/memory.js';

export async function registerFeatures(app: FastifyInstance, ctx: AppContext, ws: WsGateway, o: { runtime: ContainerRuntime; imageDir?: string; image?: string; skillSources?: InstallDeps }): Promise<{ chat: Chat; computers: Computers; memory: MemoryServices }> {
  registerSettingsRoutes(app, ctx);
  const chat = createChat(ctx);
  const computers = createComputers(ctx, chat, o.runtime, { imageDir: o.imageDir, image: o.image });
  registerChatRoutes(app, ctx, chat, {
    // FR-PC-01: a new Bot gets its computer right away; a deleted Bot's computer is archived.
    created: (user, id) => void computers.manager.ensure({ id, userId: user.id }).catch(() => undefined),
    archived: (user, id) => void computers.manager.archive({ id, userId: user.id }),
  });
  registerComputerRoutes(app, ctx, chat, computers);
  const memory = createMemory(ctx, chat, computers.manager, { install: o.skillSources });
  registerMemoryRoutes(app, ctx, chat, memory);
  ws.onUpgrade(COMPUTER_WS_PATH, (req, socket, head) => computers.vnc.handleUpgrade(req, socket, head));
  app.addHook('onClose', async () => {
    computers.close();
    await chat.close();
    memory.close();
  });
  // P1 exit criterion: an empty chat round-trip over the signed WebSocket.
  ws.on('chat.ping', (client, payload) => {
    const text = typeof (payload as { text?: unknown })?.text === 'string' ? (payload as { text: string }).text.slice(0, 2000) : '';
    return { echo: text, userId: client.user.id, at: Date.now() };
  });
  // Must be last: catch-all for the opt-in browser UI.
  registerBrowserUi(app, ctx);
  return { chat, computers, memory };
}
