// Feature modules added phase by phase register their routes and WS handlers here.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import type { WsGateway } from './ws.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerBrowserUi } from './browser-ui.js';

export async function registerFeatures(app: FastifyInstance, ctx: AppContext, ws: WsGateway): Promise<void> {
  registerSettingsRoutes(app, ctx);
  // P1 exit criterion: an empty chat round-trip over the signed WebSocket.
  ws.on('chat.ping', (client, payload) => {
    const text = typeof (payload as { text?: unknown })?.text === 'string' ? (payload as { text: string }).text.slice(0, 2000) : '';
    return { echo: text, userId: client.user.id, at: Date.now() };
  });
  // Must be last: catch-all for the opt-in browser UI.
  registerBrowserUi(app, ctx);
}
