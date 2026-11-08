// Server settings (FR-UI-07). Only the keys listed here exist (scope rule).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { getMeta, setMeta } from '../db.js';
import { authenticate, parse, sendError } from '../http.js';

export const SettingsPatch = z
  .object({
    browserUi: z.boolean().optional(),
    serverName: z.string().min(1).max(64).optional(),
  })
  .strict();

export function readSettings(ctx: AppContext) {
  return {
    browserUi: getMeta(ctx.db, 'settings.browserUi') === 'true',
    serverName: ctx.serverName(),
  };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/settings', async (req, reply) => {
    try {
      authenticate(ctx, req, 'session');
      return readSettings(ctx);
    } catch (e) {
      return sendError(reply, e);
    }
  });
  app.patch('/v1/settings', async (req, reply) => {
    try {
      authenticate(ctx, req, 'owner');
      const p = parse(SettingsPatch, req.body);
      if (p.browserUi !== undefined) setMeta(ctx.db, 'settings.browserUi', String(p.browserUi));
      if (p.serverName !== undefined) setMeta(ctx.db, 'server.name', p.serverName);
      return readSettings(ctx);
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
