// Push (D-18). Android: UnifiedPush through the self-hosted ntfy; the server only POSTs
// "wake up + id" to the device's endpoint, never content. Desktop clients get native
// notifications from the open WebSocket instead.
import { spawn, type ChildProcess } from 'node:child_process';
import { PushPayload, type User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { getMeta, setMeta } from '../db.js';
import { HttpError } from '../http.js';

const PUSH_TIMEOUT_MS = 5000;

export class Push {
  constructor(private ctx: AppContext) {}

  /** The ntfy server the owner set (or the sidecar's public URL). Endpoints must live there. */
  server(): string | null {
    return getMeta(this.ctx.db, 'push.server') ?? null;
  }

  setServer(url: string | null): void {
    if (url === null) {
      this.ctx.db.prepare("DELETE FROM meta WHERE key = 'push.server'").run();
      return;
    }
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'invalid_push_server');
    if (u.username || u.password) throw new HttpError(400, 'invalid_push_server');
    setMeta(this.ctx.db, 'push.server', u.origin);
  }

  muted(userId: string): boolean {
    return getMeta(this.ctx.db, `notify.muted:${userId}`) === 'true';
  }

  setMuted(userId: string, muted: boolean): void {
    setMeta(this.ctx.db, `notify.muted:${userId}`, String(muted));
  }

  /**
   * Registers this device's UnifiedPush endpoint. Only endpoints on the configured ntfy server
   * are accepted, so a client cannot make the server send requests anywhere else.
   */
  register(user: User, deviceId: string, endpoint: string): void {
    const server = this.server();
    if (!server) throw new HttpError(409, 'push_not_configured');
    let u: URL;
    try {
      u = new URL(endpoint);
    } catch {
      throw new HttpError(400, 'invalid_endpoint');
    }
    if (u.origin !== server || u.username || u.password) throw new HttpError(400, 'endpoint_not_on_push_server');
    this.ctx.db
      .prepare('INSERT INTO push_endpoints(device_id, user_id, endpoint, created_at) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET user_id = excluded.user_id, endpoint = excluded.endpoint, created_at = excluded.created_at')
      .run(deviceId, user.id, this.ctx.crypto.sealContent(u.href, `push:${deviceId}`), Date.now());
  }

  unregister(deviceId: string): void {
    this.ctx.db.prepare('DELETE FROM push_endpoints WHERE device_id = ?').run(deviceId);
  }

  registered(deviceId: string): boolean {
    return !!this.ctx.db.prepare('SELECT 1 FROM push_endpoints WHERE device_id = ?').get(deviceId);
  }

  /** Wakes every signed-in device of the user. Resolves once all sends finished or timed out. */
  async wake(userId: string, id: string): Promise<number> {
    if (this.muted(userId)) return 0;
    const server = this.server();
    if (!server) return 0;
    // Only active devices still signed in to this user (sign-out unbinds the device).
    const rows = this.ctx.db
      .prepare("SELECT p.device_id, p.endpoint FROM push_endpoints p JOIN devices d ON d.id = p.device_id WHERE p.user_id = ? AND d.user_id = ? AND d.status = 'active'")
      .all(userId, userId) as { device_id: string; endpoint: Buffer }[];
    const body = JSON.stringify(PushPayload.parse({ t: 'wake', id }));
    let sent = 0;
    await Promise.all(
      rows.map(async (r) => {
        const endpoint = this.ctx.crypto.openContent(r.endpoint, `push:${r.device_id}`);
        if (new URL(endpoint).origin !== server) return;
        try {
          const res = await this.ctx.fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json', ttl: '86400' }, redirect: 'error', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
          if (res.ok) sent++;
          else if (res.status === 404 || res.status === 410) this.unregister(r.device_id);
          await res.body?.cancel().catch(() => undefined);
        } catch (e) {
          this.ctx.log.warn({ err: (e as Error).message }, 'push send failed');
        }
      }),
    );
    return sent;
  }
}

/**
 * Runs the ntfy server as a sidecar when the installer put its binary in place (D-18).
 * It is restarted if it exits, with a growing delay.
 */
export class NtfySidecar {
  private child: ChildProcess | null = null;
  private stopped = false;
  private delay = 1000;
  constructor(private o: { binary: string; listen: string; baseUrl: string; cacheFile: string; log: AppContext['log'] }) {}

  start(): void {
    if (this.stopped) return;
    const args = ['serve', '--listen-http', this.o.listen, '--base-url', this.o.baseUrl, '--cache-file', this.o.cacheFile];
    const p = spawn(this.o.binary, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH } });
    this.child = p;
    p.stderr?.on('data', () => undefined);
    p.on('error', (e) => this.o.log.warn({ err: e.message }, 'ntfy sidecar failed to start'));
    p.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      this.o.log.warn({ code }, 'ntfy sidecar exited; restarting');
      setTimeout(() => this.start(), this.delay).unref();
      this.delay = Math.min(this.delay * 2, 60_000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }
}
