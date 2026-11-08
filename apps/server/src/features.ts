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
import { McpHub } from './mcp/hub.js';
import { McpTokens, registerMcpServer } from './mcp/server.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { GoogleConnections } from './google/connections.js';
import { GoogleTools, type GoogleApiBases } from './google/tools.js';
import { registerGoogleRoutes } from './routes/google.js';
import { Proactivity } from './proactive/engine.js';
import { registerProactiveRoutes } from './routes/proactive.js';

export interface McpServices { hub: McpHub; tokens: McpTokens }
export interface GoogleServices { connections: GoogleConnections; tools: GoogleTools }

export async function registerFeatures(app: FastifyInstance, ctx: AppContext, ws: WsGateway, o: { runtime: ContainerRuntime; imageDir?: string; image?: string; skillSources?: InstallDeps; mcpFetch?: typeof fetch; googleApiFetch?: typeof fetch; googleApiBases?: GoogleApiBases }): Promise<{ chat: Chat; computers: Computers; memory: MemoryServices; mcp: McpServices; google: GoogleServices; proactive: Proactivity }> {
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
  // P5: MCP client for Bots and this server's own MCP endpoint (FR-MCP-01..05).
  const hub = new McpHub(ctx, chat.bots, computers.manager, { fetch: o.mcpFetch });
  chat.runtime.setTools(hub);
  const tokens = new McpTokens(ctx);
  registerMcpRoutes(app, ctx, hub, tokens);
  let proactive: Proactivity | null = null;
  const closeMcpServer = registerMcpServer(app, ctx, chat, tokens, (user) => proactive?.summaries(user) ?? []);
  // P5: Google services for each user (FR-GGL-04..06).
  const connections = new GoogleConnections(ctx, chat.push);
  const googleTools = new GoogleTools(connections, { fetch: o.googleApiFetch, bases: o.googleApiBases });
  chat.runtime.setTools(googleTools);
  registerGoogleRoutes(app, ctx, connections);
  // P6: proactive Bots, routines and triggers (FR-PRO-01..08, NFR-SEC-11).
  proactive = new Proactivity(ctx, chat, { google: googleTools, hub, computers: computers.manager });
  registerProactiveRoutes(app, ctx, proactive);
  if (!ctx.testHooks?.manualTriggers) proactive.start();
  ws.onUpgrade(COMPUTER_WS_PATH, (req, socket, head) => computers.vnc.handleUpgrade(req, socket, head));
  app.addHook('onClose', async () => {
    await proactive?.close();
    computers.close();
    await chat.close();
    memory.close();
    await hub.close();
    await closeMcpServer();
    connections.close();
  });
  // P1 exit criterion: an empty chat round-trip over the signed WebSocket.
  ws.on('chat.ping', (client, payload) => {
    const text = typeof (payload as { text?: unknown })?.text === 'string' ? (payload as { text: string }).text.slice(0, 2000) : '';
    return { echo: text, userId: client.user.id, at: Date.now() };
  });
  // Must be last: catch-all for the opt-in browser UI.
  registerBrowserUi(app, ctx);
  return { chat, computers, memory, mcp: { hub, tokens }, google: { connections, tools: googleTools }, proactive };
}
