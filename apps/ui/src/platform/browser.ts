// Browser and default bridge (also used for the opt-in browser UI, D-16).
// Device keys are wrapped with a non-extractable AES-GCM key kept in IndexedDB.
import type { PlatformBridge, HttpReq, SocketHandlers } from './types';

const DB_NAME = 'advence-keys';

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => resolve(r.result as T | undefined);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel(key: string): Promise<void> {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => resolve();
  });
}
async function wrapKey(): Promise<CryptoKey> {
  let k = await idbGet<CryptoKey>('__wrap');
  if (!k) {
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idbSet('__wrap', k);
  }
  return k;
}

export function browserBridge(): PlatformBridge {
  return {
    platform: 'browser',
    async trustServer() {
      /* the browser UI is served by the server itself over the same TLS */
    },
    async http(req: HttpReq) {
      const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, credentials: 'omit', cache: 'no-store', redirect: 'error' });
      return { status: r.status, body: await r.text() };
    },
    socket(url: string, h: SocketHandlers) {
      const ws = new WebSocket(url);
      ws.onopen = () => h.onOpen();
      ws.onmessage = (e) => h.onMessage(String(e.data));
      ws.onclose = (e) => h.onClose(e.code);
      return { send: (d) => ws.readyState === WebSocket.OPEN && ws.send(d), close: () => ws.close() };
    },
    async loadSecret(name) {
      const v = await idbGet<{ iv: Uint8Array<ArrayBuffer>; ct: ArrayBuffer }>(`s:${name}`);
      if (!v) return null;
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: v.iv }, await wrapKey(), v.ct);
      return new TextDecoder().decode(pt);
    },
    async saveSecret(name, value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await wrapKey(), new TextEncoder().encode(value));
      await idbSet(`s:${name}`, { iv, ct });
    },
    async deleteSecret(name) {
      await idbDel(`s:${name}`);
    },
    async googleSignIn(p) {
      if (p.authUrl) window.open(p.authUrl, '_blank', 'noopener,noreferrer');
      return 'paste';
    },
    canScanQr: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    notify(title, body) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body });
    },
    openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
  };
}
