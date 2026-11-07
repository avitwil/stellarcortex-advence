// Request authentication for the REST API (NFR-SEC-02, NFR-SEC-03).
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SIG_HEADERS, type User } from '@advence/protocol';
import type { z } from 'zod';
import { AuthError } from './auth/google.js';
import type { AppContext } from './context.js';

export type AuthLevel = 'device' | 'device-pending' | 'session' | 'owner';

export interface RequestAuth {
  deviceId: string;
  user?: User;
  token?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    auth?: RequestAuth;
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

const AUTH_STATUS: Record<string, number> = {
  not_allowlisted: 403,
  forbidden: 403,
  device_revoked: 403,
  email_not_verified: 403,
  cannot_remove_owner: 409,
  device_bound_to_other_user: 403,
  code_mismatch: 400,
  pairing_not_pending: 409,
  invalid_pairing_token: 400,
  key_already_registered: 409,
  invalid_public_key: 400,
  google_not_configured: 409,
};

export function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof HttpError) return reply.code(e.status).send({ error: e.code, message: e.message !== e.code ? e.message : undefined });
  if (e instanceof AuthError) return reply.code(AUTH_STATUS[e.code] ?? 401).send({ error: e.code });
  throw e;
}

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h) return '';
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(h);
  return m ? m[1]! : '';
}

export function authenticate(ctx: AppContext, req: FastifyRequest, level: AuthLevel): RequestAuth {
  const deviceId = String(req.headers[SIG_HEADERS.device] ?? '');
  const ts = Number(req.headers[SIG_HEADERS.ts] ?? NaN);
  const nonce = String(req.headers[SIG_HEADERS.nonce] ?? '');
  const sig = String(req.headers[SIG_HEADERS.sig] ?? '');
  if (!deviceId || !sig) throw new AuthError('signature_required');
  const token = bearer(req);
  const device = ctx.identity.verifySigned(
    { deviceId, ts, nonce, sig, method: req.method, path: req.url, body: req.rawBody ?? new Uint8Array(0), token },
    level === 'device-pending',
  );
  if (level === 'device' || level === 'device-pending') {
    if (token) {
      try {
        const s = ctx.identity.checkSession(token, device.id);
        return { deviceId: device.id, user: s.user, token };
      } catch {
        /* a device-level route does not need a session */
      }
    }
    return { deviceId: device.id };
  }
  if (!token) throw new AuthError('session_required');
  const s = ctx.identity.checkSession(token, device.id);
  if (level === 'owner' && s.user.role !== 'owner') throw new AuthError('forbidden');
  return { deviceId: device.id, user: s.user, token };
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'invalid_request', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
