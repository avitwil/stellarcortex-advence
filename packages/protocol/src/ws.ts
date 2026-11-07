// WebSocket frames (NFR-SEC-02 signed frames, NFR-REL-01 heartbeat).
import { z } from 'zod';

export const WS_PATH = '/v1/ws';
/** Server sends a ping at this interval; clients treat 3 missed pings as a dead stream. */
export const HEARTBEAT_MS = 10_000;
export const HEARTBEAT_DEAD_MS = 30_000;

export const WsAuthFrame = z.object({
  type: z.literal('auth'),
  deviceId: z.string(),
  token: z.string(),
  ts: z.number(),
  nonce: z.string(),
  sig: z.string(),
});

/** Every client frame after auth is signed over canonicalFrame(). */
export const WsClientFrame = z.object({
  type: z.string().min(1).max(64),
  id: z.string().max(64).optional(),
  payload: z.string().max(1_000_000),
  ts: z.number(),
  nonce: z.string(),
  sig: z.string(),
});
export type WsClientFrame = z.infer<typeof WsClientFrame>;

export const WsServerFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), sessionExpiresAt: z.number() }),
  z.object({ type: z.literal('ping'), t: z.number() }),
  z.object({ type: z.literal('ack'), id: z.string(), ok: z.boolean(), error: z.string().optional(), data: z.unknown().optional() }),
  z.object({ type: z.literal('event'), event: z.string(), data: z.unknown() }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);
export type WsServerFrame = z.infer<typeof WsServerFrame>;
