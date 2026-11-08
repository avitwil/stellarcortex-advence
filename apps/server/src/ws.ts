// WebSocket gateway (NFR-SEC-02 signed frames, NFR-SEC-03 sessions, NFR-REL-01 heartbeat).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { WsAuthFrame, WsClientFrame, canonicalFrame, verify, fromB64url, HEARTBEAT_MS, WS_PATH, type User, type WsServerFrame } from '@advence/protocol';
import type { AppContext } from './context.js';
import { AuthError } from './auth/google.js';

export interface WsClient {
  ws: WebSocket;
  deviceId: string;
  user: User;
  sessionExpiresAt: number;
  sessionHash: string;
}

export type WsHandler = (client: WsClient, payload: unknown) => Promise<unknown> | unknown;

const AUTH_TIMEOUT_MS = 5000;
const MAX_FRAME = 1_100_000;

export class WsGateway {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  private clients = new Set<WsClient>();
  private handlers = new Map<string, WsHandler>();
  private timer: NodeJS.Timeout;

  constructor(private ctx: AppContext) {
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
    ctx.bus.subscribe((e) => {
      for (const c of this.clients) {
        if (!(e.userId === '*' ? c.user.role === 'owner' : c.user.id === e.userId)) continue;
        // No data flows on a socket whose session has expired or ended (NFR-SEC-03).
        if (!this.sessionValid(c)) continue;
        this.send(c, { type: 'event', event: e.event, data: e.data });
      }
    });
  }

  on(type: string, h: WsHandler): void {
    this.handlers.set(type, h);
  }

  private upgrades = new Map<string, (req: IncomingMessage, socket: Duplex, head: Buffer) => void>();

  /** Other WebSocket endpoints (the computer live view) share the TLS listener. */
  onUpgrade(path: string, h: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): void {
    this.upgrades.set(path, h);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = (req.url ?? '').split('?')[0] ?? '';
    const other = this.upgrades.get(url);
    if (other) return other(req, socket, head);
    if (url !== WS_PATH) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  closeDevice(deviceId: string, code = 4003, reason = 'revoked'): void {
    for (const c of this.clients) if (c.deviceId === deviceId) c.ws.close(code, reason);
  }

  private sessionValid(c: WsClient): boolean {
    return c.sessionExpiresAt > Date.now() && this.ctx.identity.sessionAlive(c.sessionHash);
  }

  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.ws.terminate();
    this.wss.close();
  }

  private send(c: WsClient | { ws: WebSocket }, f: WsServerFrame): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(f));
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const c of this.clients) {
      const alive = (c.ws as WebSocket & { isAlive?: boolean }).isAlive;
      if (alive === false) {
        c.ws.terminate();
        continue;
      }
      (c.ws as WebSocket & { isAlive?: boolean }).isAlive = false;
      c.ws.ping();
      this.send(c, { type: 'ping', t: now });
    }
  }

  private authenticate(raw: string): { deviceId: string; user: User; expiresAt: number; hash: string } {
    const f = WsAuthFrame.parse(JSON.parse(raw));
    const d = this.ctx.identity.getDevice(f.deviceId);
    if (!d || d.status !== 'active') throw new AuthError('device_not_active');
    this.ctx.identity.checkFreshNonce(f.deviceId, f.ts, f.nonce);
    const ok = verify(new Uint8Array(d.public_key), canonicalFrame({ deviceId: f.deviceId, ts: f.ts, nonce: f.nonce, type: 'auth', payload: f.token }), fromB64url(f.sig));
    if (!ok) throw new AuthError('bad_signature');
    const s = this.ctx.identity.checkSession(f.token, f.deviceId);
    return { deviceId: f.deviceId, user: s.user, expiresAt: s.expiresAt, hash: s.hash };
  }

  private accept(ws: WebSocket): void {
    let client: WsClient | null = null;
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => ((ws as WebSocket & { isAlive?: boolean }).isAlive = true));
    const authTimer = setTimeout(() => !client && ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (client) this.clients.delete(client);
    });
    ws.on('message', async (data, isBinary) => {
      if (isBinary) return ws.close(4000, 'binary not allowed');
      const raw = data.toString();
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
      try {
        if (raw.length > MAX_FRAME) throw new AuthError('frame_too_large');
        const parsed = JSON.parse(raw) as { type?: unknown };
        // The first frame, and any later re-auth after a session refresh, is an auth frame.
        if (parsed.type === 'auth' || !client) {
          const a = this.authenticate(raw);
          if (client && (a.deviceId !== client.deviceId || a.user.id !== client.user.id)) throw new AuthError('identity_change');
          if (!client) {
            client = { ws, deviceId: a.deviceId, user: a.user, sessionExpiresAt: a.expiresAt, sessionHash: a.hash };
            this.clients.add(client);
            clearTimeout(authTimer);
          } else {
            client.sessionExpiresAt = a.expiresAt;
            client.sessionHash = a.hash;
          }
          this.send(client, { type: 'ready', sessionExpiresAt: a.expiresAt });
          return;
        }
        if (!this.sessionValid(client)) {
          this.send(client, { type: 'error', error: 'session_expired' });
          return;
        }
        const d = this.ctx.identity.getDevice(client.deviceId);
        if (!d || d.status !== 'active') return ws.close(4003, 'revoked');
        const f = WsClientFrame.parse(JSON.parse(raw));
        this.ctx.identity.checkFreshNonce(client.deviceId, f.ts, f.nonce);
        if (!verify(new Uint8Array(d.public_key), canonicalFrame({ deviceId: client.deviceId, ts: f.ts, nonce: f.nonce, type: f.type, payload: f.payload }), fromB64url(f.sig))) {
          throw new AuthError('bad_signature');
        }
        const h = this.handlers.get(f.type);
        if (!h) {
          if (f.id) this.send(client, { type: 'ack', id: f.id, ok: false, error: 'unknown_type' });
          return;
        }
        try {
          const out = await h(client, JSON.parse(f.payload));
          if (f.id) this.send(client, { type: 'ack', id: f.id, ok: true, data: out });
        } catch (e) {
          this.ctx.log.warn({ err: (e as Error).message, type: f.type }, 'ws handler failed');
          if (f.id) this.send(client, { type: 'ack', id: f.id, ok: false, error: e instanceof AuthError ? e.code : 'handler_error' });
        }
      } catch (e) {
        const code = e instanceof AuthError ? e.code : 'bad_frame';
        this.ctx.log.warn({ code }, 'ws frame rejected');
        if (!client) ws.close(4001, code);
        else this.send(client, { type: 'error', error: code });
      }
    });
  }
}
