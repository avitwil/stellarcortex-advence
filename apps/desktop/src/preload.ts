// Preload (sandboxed, contextIsolation): exposes a narrow, typed API to the UI.
import { contextBridge, ipcRenderer } from 'electron';

const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

contextBridge.exposeInMainWorld('advenceDesktop', {
  platform,
  trustServer: (host: string, pin: string) => ipcRenderer.invoke('trustServer', host, pin),
  loadSecret: (name: string) => ipcRenderer.invoke('loadSecret', name),
  saveSecret: (name: string, value: string) => ipcRenderer.invoke('saveSecret', name, value),
  deleteSecret: (name: string) => ipcRenderer.invoke('deleteSecret', name),
  oauthLoopback: (authUrl: string) => ipcRenderer.invoke('oauthLoopback', authUrl),
  openExternal: (url: string) => ipcRenderer.invoke('openExternal', url),
  notify: (title: string, body: string) => ipcRenderer.send('notify', title, body),
  http: (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => ipcRenderer.invoke('http', req),
  wsOpen: (id: string, url: string) => ipcRenderer.invoke('wsOpen', id, url),
  wsSend: (id: string, data: string) => ipcRenderer.send('wsSend', id, data),
  wsClose: (id: string) => ipcRenderer.send('wsClose', id),
  onWsEvent: (fn: (e: { id: string; kind: 'open' | 'message' | 'close'; data?: string; code?: number }) => void) => {
    const h = (_ev: unknown, e: { id: string; kind: 'open' | 'message' | 'close'; data?: string; code?: number }) => fn(e);
    ipcRenderer.on('wsEvent', h);
    return () => ipcRenderer.off('wsEvent', h);
  },
});
