// Server update routes (D-24, FR-CLI-05): the owner sees the status, checks and installs.
import type { FastifyInstance } from 'fastify';
import { ReleaseError } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError, router } from '../http.js';
import { UpdateError, type Updater } from '../update/updater.js';

const STATUS: Record<string, number> = { not_service: 409, busy: 409, up_to_date: 409, runtime_changed: 409 };

export function registerUpdateRoutes(app: FastifyInstance, ctx: AppContext, updater: Updater): void {
  const route = router(app, ctx);
  route('GET', '/v1/update', 'owner', () => updater.status());
  route('POST', '/v1/update/check', 'owner', () => updater.check());
  route('POST', '/v1/update/apply', 'owner', async () => {
    try {
      const version = await updater.apply();
      ctx.log.info({ version }, 'update staged; restarting');
      return { ok: true, version };
    } catch (e) {
      if (e instanceof UpdateError) throw new HttpError(STATUS[e.code] ?? 502, e.code);
      if (e instanceof ReleaseError) throw new HttpError(502, e.code);
      throw e;
    }
  });
}
