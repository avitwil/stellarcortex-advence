// Event stream with signed frames, heartbeat detection and automatic reconnect (NFR-REL-01).
import { sign, canonicalFrame, newNonce, toB64url, HEARTBEAT_DEAD_MS, type WsServerFrame } from '@advence/protocol';
import type { PlatformBridge, SocketConn } from '../platform/types';
import type { ApiClient } from './client';

export type SocketState = 'connecting' | 'open' | 'reconnecting' | 'stopped';

export class ReconnectingSocket {
  state: SocketState = 'connecting';
  private conn: SocketConn | null = null;
  private lastFrame = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private stopped = false;
  private seq = 0;
  /** Incremented whenever a connection is abandoned, so its late callbacks are ignored. */
  private gen = 0;
  private pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  private listeners = new Set<(event: string, data: unknown) => void>();
  private stateListeners = new Set<(s: SocketState) => void>();

  constructor(private api: ApiClient, private bridge: PlatformBridge, private now: () => number = Date.now) {
    void this.connect();
    this.watchdog = setInterval(() => this.check(), 5000);
  }

  onEvent(fn: (event: string, data: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn: (s: SocketState) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }

  private setState(s: SocketState) {
    this.state = s;
    this.stateListeners.forEach((f) => f(s));
  }

  /** A stream that has been silent for HEARTBEAT_DEAD_MS is dead: reconnect. */
  check(): void {
    if (this.state === 'open' && this.now() - this.lastFrame > HEARTBEAT_DEAD_MS) {
      this.abandon();
      this.reconnect();
    }
  }

  private abandon(): void {
    this.gen++;
    const c = this.conn;
    this.conn = null;
    c?.close();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.api.ensureSession();
      await this.bridge.trustServer(this.api.server.host, this.api.server.pin);
    } catch {
      return this.reconnect();
    }
    if (this.stopped) return;
    const url = `wss://${this.api.server.host}/v1/ws`;
    const my = ++this.gen;
    this.conn = this.bridge.socket(url, {
      onOpen: () => {
        if (my !== this.gen) return;
        this.lastFrame = this.now();
        void this.sendAuth();
      },
      onMessage: (d) => my === this.gen && this.onMessage(d),
      onClose: (code) => {
        if (my !== this.gen) return;
        this.conn = null;
        if (code === 4003 || code === 4004) {
          this.stop();
          this.listeners.forEach((f) => f(code === 4003 ? 'device.revoked' : 'session.ended', null));
          return;
        }
        this.reconnect();
      },
    });
  }

  private reconnect(): void {
    if (this.stopped) return;
    this.setState('reconnecting');
    for (const p of this.pending.values()) p.reject(new Error('disconnected'));
    this.pending.clear();
    const delay = Math.min(30_000, 500 * 2 ** this.attempt++) + Math.random() * 250;
    setTimeout(() => void this.connect(), delay);
  }

  private async sendAuth(): Promise<void> {
    const sk = await this.api.secretKey();
    const ts = Date.now();
    const nonce = newNonce();
    const deviceId = this.api.server.deviceId!;
    const sig = toB64url(sign(sk, canonicalFrame({ deviceId, ts, nonce, type: 'auth', payload: this.api.token })));
    this.conn?.send(JSON.stringify({ type: 'auth', deviceId, token: this.api.token, ts, nonce, sig }));
  }

  reauth(): void {
    if (this.conn && this.state === 'open') void this.sendAuth();
  }

  private onMessage(raw: string): void {
    this.lastFrame = this.now();
    let f: WsServerFrame;
    try {
      f = JSON.parse(raw) as WsServerFrame;
    } catch {
      return;
    }
    if (f.type === 'ready') {
      this.attempt = 0;
      this.setState('open');
    } else if (f.type === 'ack') {
      const p = this.pending.get(f.id);
      if (p) {
        this.pending.delete(f.id);
        if (f.ok) p.resolve(f.data);
        else p.reject(new Error(f.error ?? 'failed'));
      }
    } else if (f.type === 'event') {
      this.listeners.forEach((fn) => fn(f.event, f.data));
    } else if (f.type === 'error' && f.error === 'session_expired') {
      void this.api.refresh().catch(() => undefined);
    }
  }

  async send<T = unknown>(type: string, payload: unknown): Promise<T> {
    if (!this.conn || this.state !== 'open') throw new Error('offline');
    const id = `c${++this.seq}`;
    const sk = await this.api.secretKey();
    const ts = Date.now();
    const nonce = newNonce();
    const p = JSON.stringify(payload);
    const sig = toB64url(sign(sk, canonicalFrame({ deviceId: this.api.server.deviceId!, ts, nonce, type, payload: p })));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.conn!.send(JSON.stringify({ type, id, payload: p, ts, nonce, sig }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('timeout'));
      }, 30_000);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.abandon();
    this.setState('stopped');
  }
}
