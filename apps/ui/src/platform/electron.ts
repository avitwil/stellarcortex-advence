// Electron bridge: the preload script exposes `window.advenceDesktop` (contextIsolation on).
// Server traffic goes through the main process, which connects only with the pinned key
// (DL-016); the renderer's CSP allows no direct network connections.
import type { Platform } from '@advence/protocol';
import type { PlatformBridge, SocketHandlers } from './types';
import { browserBridge } from './browser';

export interface DesktopApi {
  platform: Platform;
  trustServer(host: string, pin: string): Promise<void>;
  loadSecret(name: string): Promise<string | null>;
  saveSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  oauthLoopback(authUrl: string): Promise<{ code: string; state: string; callbackUrl: string }>;
  openExternal(url: string): Promise<void>;
  notify(title: string, body: string): void;
  http(req: { url: string; method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; body: string }>;
  wsOpen(id: string, url: string): Promise<void>;
  wsSend(id: string, data: string): void;
  wsClose(id: string): void;
  onWsEvent(fn: (e: { id: string; kind: 'open' | 'message' | 'close'; data?: string; code?: number }) => void): () => void;
}

declare global {
  interface Window {
    advenceDesktop?: DesktopApi;
  }
}

export function electronBridge(api: DesktopApi): PlatformBridge {
  const base = browserBridge();
  const sockets = new Map<string, SocketHandlers>();
  api.onWsEvent((e) => {
    const h = sockets.get(e.id);
    if (!h) return;
    if (e.kind === 'open') h.onOpen();
    else if (e.kind === 'message') h.onMessage(e.data ?? '');
    else {
      sockets.delete(e.id);
      h.onClose(e.code ?? 1006);
    }
  });
  let seq = 0;
  return {
    ...base,
    platform: api.platform,
    trustServer: (h, p) => api.trustServer(h, p),
    http: (req) => api.http(req),
    socket(url, h) {
      const id = `d${++seq}`;
      sockets.set(id, h);
      api.wsOpen(id, url).catch(() => {
        sockets.delete(id);
        h.onClose(1006);
      });
      return { send: (d) => api.wsSend(id, d), close: () => api.wsClose(id) };
    },
    loadSecret: (n) => api.loadSecret(n),
    saveSecret: (n, v) => api.saveSecret(n, v),
    deleteSecret: (n) => api.deleteSecret(n),
    async googleSignIn(p) {
      if (!p.authUrl) throw new Error('missing auth url');
      return api.oauthLoopback(p.authUrl);
    },
    async authorize(authUrl) {
      // The loopback receiver takes HTTPS authorization pages only; anything else is pasted.
      if (!authUrl.startsWith('https://')) {
        api.openExternal(authUrl);
        return 'paste';
      }
      const r = await api.oauthLoopback(authUrl);
      return { callbackUrl: r.callbackUrl };
    },
    canScanQr: false,
    notify: (t, b) => api.notify(t, b),
    openExternal: (u) => void api.openExternal(u),
  };
}
