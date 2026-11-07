// Live view channel (FR-UI-05): a WebSocket-like object that noVNC drives, carried over the
// platform's pinned socket (TLS 1.3 to our server only). The first frame is a signed auth frame;
// after the server answers "ready", RFB bytes travel as base64 text frames both ways, because
// every client bridge (browser, Electron main process, Android OkHttp) carries text.
import { canonicalFrame, COMPUTER_WS_PATH, newNonce, sign, toB64url } from '@advence/protocol';
import type { PlatformBridge, SocketConn } from '../platform/types';
import type { ApiClient } from './client';

type State = 'connecting' | 'open' | 'closing' | 'closed';

export function bytesToB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export class VncChannel {
  // noVNC checks that these exist as properties of the channel.
  binaryType = 'arraybuffer';
  protocol = 'binary';
  readyState: State = 'connecting';
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private conn: SocketConn | null = null;

  constructor(private api: ApiClient, private bridge: PlatformBridge, private botId: string) {
    void this.connect();
  }

  private async connect(): Promise<void> {
    try {
      await this.api.ensureSession();
      await this.bridge.trustServer(this.api.server.host, this.api.server.pin);
    } catch {
      return this.finish(4002);
    }
    if (this.readyState !== 'connecting') return;
    this.conn = this.bridge.socket(`wss://${this.api.server.host}${COMPUTER_WS_PATH}`, {
      onOpen: () => void this.auth(),
      onMessage: (d) => this.receive(d),
      onClose: (code) => this.finish(code),
    });
  }

  private async auth(): Promise<void> {
    const sk = await this.api.secretKey();
    const deviceId = this.api.server.deviceId!;
    const ts = Date.now();
    const nonce = newNonce();
    const token = this.api.token;
    const payload = JSON.stringify({ token, botId: this.botId });
    const sig = toB64url(sign(sk, canonicalFrame({ deviceId, ts, nonce, type: 'computer.auth', payload })));
    this.conn?.send(JSON.stringify({ type: 'auth', deviceId, token, botId: this.botId, ts, nonce, sig }));
  }

  private receive(d: string): void {
    if (this.readyState === 'connecting') {
      if (d === '{"type":"ready"}') {
        this.readyState = 'open';
        this.onopen?.({});
      }
      return;
    }
    if (this.readyState !== 'open') return;
    this.onmessage?.({ data: b64ToBytes(d).buffer });
  }

  send(data: ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 'open') return;
    this.conn?.send(bytesToB64(data instanceof Uint8Array ? data : new Uint8Array(data)));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closing';
    const c = this.conn;
    this.conn = null;
    c?.close();
    this.finish(1000);
  }

  private finish(code: number): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.conn = null;
    this.onclose?.({ code, reason: '', wasClean: code === 1000 });
  }
}
