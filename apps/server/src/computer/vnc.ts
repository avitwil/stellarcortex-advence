// Live view proxy (FR-UI-05): client <-> server WebSocket (pinned TLS 1.3, signed auth frame,
// session checked for the whole connection) <-> the Bot computer's websockify on the host
// loopback. RFB bytes travel as base64 text frames, because every client bridge carries text.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { canonicalFrame, ComputerWsAuth, fromB64url, verify } from '@advence/protocol';
import type { AppContext } from '../context.js';
import type { ComputerManager } from './manager.js';

const AUTH_TIMEOUT_MS = 5000;
const SESSION_CHECK_MS = 15_000;
const MAX_FRAME = 4 * 1024 * 1024;
const CHUNK = 512 * 1024;

export class VncProxy {
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  private open = new Set<WebSocket>();

  constructor(private ctx: AppContext, private computers: ComputerManager, private ownerOf: (botId: string) => string | undefined) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  close(): void {
    for (const ws of this.open) ws.terminate();
    this.wss.close();
  }

  private accept(client: WebSocket): void {
    this.open.add(client);
    let upstream: WebSocket | null = null;
    let check: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => !upstream && client.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);
    const end = () => {
      clearTimeout(timer);
      if (check) clearInterval(check);
      this.open.delete(client);
      upstream?.terminate();
    };
    client.on('close', end);
    client.on('error', end);
    client.once('message', async (data, isBinary) => {
      try {
        if (isBinary) throw new Error('binary');
        const f = ComputerWsAuth.parse(JSON.parse(data.toString()));
        const d = this.ctx.identity.getDevice(f.deviceId);
        if (!d || d.status !== 'active') throw new Error('device');
        this.ctx.identity.checkFreshNonce(f.deviceId, f.ts, f.nonce);
        const payload = JSON.stringify({ token: f.token, botId: f.botId });
        if (!verify(new Uint8Array(d.public_key), canonicalFrame({ deviceId: f.deviceId, ts: f.ts, nonce: f.nonce, type: 'computer.auth', payload }), fromB64url(f.sig))) throw new Error('signature');
        const s = this.ctx.identity.checkSession(f.token, f.deviceId);
        // Only the Bot's own user sees its computer.
        if (this.ownerOf(f.botId) !== s.user.id) throw new Error('not_found');
        const { port } = await this.computers.vnc(f.botId);
        clearTimeout(timer);
        check = setInterval(() => {
          const dev = this.ctx.identity.getDevice(f.deviceId);
          if (s.expiresAt <= Date.now() || !this.ctx.identity.sessionAlive(s.hash) || !dev || dev.status !== 'active') client.close(4003, 'session ended');
        }, SESSION_CHECK_MS);
        check.unref();
        upstream = new WebSocket(`ws://127.0.0.1:${port}/websockify`, ['binary']);
        const pending: Buffer[] = [];
        upstream.on('open', () => {
          client.send(JSON.stringify({ type: 'ready' }));
          for (const b of pending.splice(0)) upstream!.send(b);
        });
        // RFB is a byte stream, so large reads are split to stay under every client's frame limit.
        upstream.on('message', (m: Buffer) => {
          for (let i = 0; i < m.length && client.readyState === client.OPEN; i += CHUNK) client.send(m.subarray(i, i + CHUNK).toString('base64'));
        });
        upstream.on('close', () => client.close(1000, 'computer closed'));
        upstream.on('error', () => client.close(1011, 'computer unreachable'));
        client.on('message', (m, bin) => {
          if (bin) return client.close(4000, 'binary not allowed');
          const b = Buffer.from(m.toString(), 'base64');
          if (upstream!.readyState === WebSocket.OPEN) upstream!.send(b);
          else pending.push(b);
        });
      } catch (e) {
        this.ctx.log.warn({ err: (e as Error).message }, 'computer view refused');
        client.close(4001, 'refused');
      }
    });
  }
}
