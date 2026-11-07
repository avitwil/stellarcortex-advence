// Platform bridge implemented by each shell (Electron preload, Capacitor plugins, browser).
import type { Platform } from '@advence/protocol';

export interface HttpReq {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
export interface HttpRes {
  status: number;
  body: string;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number): void;
}
export interface SocketConn {
  send(data: string): void;
  close(): void;
}

export interface PlatformBridge {
  platform: Platform;
  /** Registers the pinned server key with the native TLS layer before any request. */
  trustServer(host: string, pin: string): Promise<void>;
  http(req: HttpReq): Promise<HttpRes>;
  socket(url: string, h: SocketHandlers): SocketConn;
  /** Device key seed storage, protected by the OS where possible. */
  loadSecret(name: string): Promise<string | null>;
  saveSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  /** Google sign-in: desktop returns a code via loopback, Android returns an ID token. */
  googleSignIn(p: { authUrl?: string; clientId?: string }): Promise<{ code?: string; state?: string; idToken?: string } | 'paste'>;
  canScanQr: boolean;
  notify(title: string, body: string): void;
  openExternal(url: string): void;
}
