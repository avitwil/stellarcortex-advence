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
  /**
   * Any OAuth authorization in the system browser with the loopback redirect (Google services,
   * MCP servers): desktop returns the full callback URL; browser and Android open the page and
   * the user pastes the address they land on.
   */
  authorize(authUrl: string): Promise<{ callbackUrl: string } | 'paste'>;
  /** Android: Google's authorization client for the service scopes; returns a server auth code. */
  googleAuthorize?(p: { clientId: string; scopes: string[] }): Promise<{ serverAuthCode: string }>;
  canScanQr: boolean;
  notify(title: string, body: string): void;
  /** Android: registers with the UnifiedPush distributor for this push server; returns the endpoint. */
  registerPush?(pushServer: string): Promise<string | null>;
  openExternal(url: string): void;
}
