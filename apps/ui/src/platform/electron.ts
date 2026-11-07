// Electron bridge: the preload script exposes `window.advenceDesktop` (contextIsolation on).
// The renderer uses fetch/WebSocket directly; the main process enforces the pinned key
// through setCertificateVerifyProc (DL-016).
import type { Platform } from '@advence/protocol';
import type { PlatformBridge } from './types';
import { browserBridge } from './browser';

export interface DesktopApi {
  platform: Platform;
  trustServer(host: string, pin: string): Promise<void>;
  loadSecret(name: string): Promise<string | null>;
  saveSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  oauthLoopback(authUrl: string): Promise<{ code: string; state: string }>;
  openExternal(url: string): Promise<void>;
  notify(title: string, body: string): void;
}

declare global {
  interface Window {
    advenceDesktop?: DesktopApi;
  }
}

export function electronBridge(api: DesktopApi): PlatformBridge {
  const base = browserBridge();
  return {
    ...base,
    platform: api.platform,
    trustServer: (h, p) => api.trustServer(h, p),
    loadSecret: (n) => api.loadSecret(n),
    saveSecret: (n, v) => api.saveSecret(n, v),
    deleteSecret: (n) => api.deleteSecret(n),
    async googleSignIn(p) {
      if (!p.authUrl) throw new Error('missing auth url');
      return api.oauthLoopback(p.authUrl);
    },
    canScanQr: false,
    notify: (t, b) => api.notify(t, b),
    openExternal: (u) => void api.openExternal(u),
  };
}
