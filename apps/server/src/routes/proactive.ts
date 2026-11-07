// Proactive Bots (P6): routines and their runs (FR-PRO-02, FR-UI-06), the global pause
// (FR-PRO-06), suggestion cards (FR-PRO-04), held actions (NFR-SEC-11) and the public webhook
// trigger, which is reachable without a session but only with the routine's secret address.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ProactiveState, RoutineCreate, RoutinePatch } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError, parse, router, sendError, userOf } from '../http.js';
import { RateLimiter } from '../ratelimit.js';
import type { Proactivity } from '../proactive/engine.js';

const params = (req: FastifyRequest) => req.params as Record<string, string>;
const query = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
const MAX_HOOK_BODY = 64 * 1024;

/** The address clients reach this server at, for webhook links. */
function originOf(req: FastifyRequest): string | null {
  const host = req.headers.host;
  return host && /^[a-z0-9.\-[\]:]+$/i.test(host) ? `https://${host}` : null;
}

export function registerProactiveRoutes(app: FastifyInstance, ctx: AppContext, p: Proactivity, o: { hookLimiter?: RateLimiter } = {}): void {
  const route = router(app, ctx);
  route('GET', '/v1/routines', 'session', (req) => ({ routines: p.list(userOf(req), originOf(req)) }));
  route('POST', '/v1/routines', 'session', (req) => p.create(userOf(req), parse(RoutineCreate, req.body), originOf(req)));
  route('GET', '/v1/routines/runs', 'session', (req) => {
    const q = query(req);
    return { runs: p.runs(userOf(req), { routineId: q.routineId, limit: q.limit ? Number(q.limit) || undefined : undefined }) };
  });
  route('PATCH', '/v1/routines/:id', 'session', (req) => p.patch(userOf(req), params(req).id!, parse(RoutinePatch, req.body), originOf(req)));
  route('DELETE', '/v1/routines/:id', 'session', async (req) => {
    await p.remove(userOf(req), params(req).id!);
  });
  route('POST', '/v1/routines/:id/run', 'session', (req) => p.runNow(userOf(req), params(req).id!));

  route('GET', '/v1/proactive', 'session', (req) => ({ paused: p.userPaused(userOf(req).id) }));
  route('PUT', '/v1/proactive', 'session', (req) => p.setPaused(userOf(req), parse(ProactiveState, req.body).paused));

  route('GET', '/v1/suggestions', 'session', (req) => ({ suggestions: p.suggestions(userOf(req)) }));
  route('POST', '/v1/suggestions/:id/run', 'session', (req) => p.runSuggestion(userOf(req), params(req).id!));
  route('POST', '/v1/suggestions/:id/dismiss', 'session', (req) => p.dismiss(userOf(req), params(req).id!));

  route('GET', '/v1/held', 'session', (req) => ({ held: p.held(userOf(req)) }));
  route('POST', '/v1/held/:id', 'session', (req) => p.decide(userOf(req), params(req).id!, parse(z.object({ allow: z.boolean() }).strict(), req.body).allow));

  // Webhook trigger (FR-PRO-02). No session: the secret in the address is the credential.
  const limiter = o.hookLimiter ?? new RateLimiter(30, 60_000);
  app.route({
    method: 'POST',
    url: '/v1/hooks/:id/:secret',
    bodyLimit: MAX_HOOK_BODY,
    handler: async (req, reply) => {
      try {
        const { id, secret } = params(req);
        if (!limiter.take(`ip:${req.ip}`) || !limiter.take(`hook:${id}`)) throw new HttpError(429, 'rate_limited');
        if (!id || !secret || id.length > 64 || secret.length > 128) throw new HttpError(404, 'not_found');
        const b = req.body;
        const text = Buffer.isBuffer(b) ? b.toString('utf8') : b === undefined || b === null ? '' : JSON.stringify(b);
        return reply.send(p.webhook(id, secret, text));
      } catch (e) {
        return sendError(reply, e);
      }
    },
  });
}
