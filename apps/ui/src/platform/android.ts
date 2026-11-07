// Android bridge: Capacitor plugins implemented in apps/android (PinnedHttp, SecureStore,
// GoogleSignIn, Push). All server traffic goes through OkHttp with the pinned key (DL-016).
import type { PlatformBridge, SocketHandlers } from './types';
import { browserBridge } from './browser';

interface CapPlugin {
  addListener(event: string, fn: (e: any) => void): Promise<{ remove(): void }> | { remove(): void };
  [k: string]: any;
}
interface CapacitorGlobal {
  isNativePlatform(): boolean;
  getPlatform(): string;
  Plugins: Record<string, CapPlugin>;
}
declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
  }
}

export function isAndroidNative(): boolean {
  return !!window.Capacitor?.isNativePlatform?.() && window.Capacitor.getPlatform() === 'android';
}

export function androidBridge(): PlatformBridge {
  const P = window.Capacitor!.Plugins;
  const http = P.PinnedHttp!;
  const store = P.SecureStore!;
  const gsi = P.GoogleSignIn!;
  const sockets = new Map<string, SocketHandlers>();
  void http.addListener('wsEvent', (e: { id: string; kind: 'open' | 'message' | 'close'; data?: string; code?: number }) => {
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
    ...browserBridge(),
    platform: 'android',
    trustServer: (host, pin) => http.trust({ host, pin }),
    http: (req) => http.request(req),
    socket(url, h) {
      const id = `s${++seq}`;
      sockets.set(id, h);
      void http.wsOpen({ id, url });
      return { send: (data) => void http.wsSend({ id, data }), close: () => void http.wsClose({ id }) };
    },
    async loadSecret(name) {
      const r = await store.get({ key: name });
      return r.value ?? null;
    },
    saveSecret: (name, value) => store.set({ key: name, value }),
    deleteSecret: (name) => store.remove({ key: name }),
    async googleSignIn(p) {
      if (!p.clientId) throw new Error('missing client id');
      const r = await gsi.signIn({ serverClientId: p.clientId });
      return { idToken: r.idToken };
    },
    async authorize(authUrl) {
      // A Custom Tab; the user copies the localhost address it ends on (DL-057).
      window.open(authUrl, '_blank', 'noopener,noreferrer');
      return 'paste';
    },
    async googleAuthorize(p) {
      const r = await gsi.authorize({ serverClientId: p.clientId, scopes: p.scopes });
      if (typeof r.serverAuthCode !== 'string') throw new Error('no server auth code');
      return { serverAuthCode: r.serverAuthCode };
    },
    canScanQr: true,
    async registerPush(pushServer) {
      const r = await P.Push!.register({ pushServer });
      return r.endpoint ?? null;
    },
  };
}
