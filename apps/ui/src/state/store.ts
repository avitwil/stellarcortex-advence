import { create } from 'zustand';
import type { ServerInfo, User } from '@advence/protocol';
import { ApiClient, ApiError } from '../api/client';
import { loadServers, saveServers, activeServerId, setActiveServerId, serverFromLink, parseLink, type SavedServer } from '../api/servers';
import { platform } from '../platform';
import { applyLang, initialLang, type Lang } from '../i18n';

export type Phase = 'loading' | 'connect' | 'pairing' | 'setup' | 'login' | 'ready';
export type Theme = 'light' | 'dark' | 'system';

interface State {
  phase: Phase;
  servers: SavedServer[];
  active: SavedServer | null;
  client: ApiClient | null;
  info: ServerInfo | null;
  user: User | null;
  error: string | null;
  lang: Lang;
  theme: Theme;
  init(): Promise<void>;
  addFromLink(text: string): Promise<void>;
  switchServer(id: string): Promise<void>;
  removeServer(id: string): Promise<void>;
  showConnect(): void;
  resolvePhase(): Promise<void>;
  setUser(u: User): void;
  updateServer(s: SavedServer): void;
  signOut(): Promise<void>;
  setLang(l: Lang): void;
  setTheme(t: Theme): void;
  setError(e: string | null): void;
}

function applyTheme(t: Theme) {
  const dark = t === 'dark' || (t === 'system' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try {
    localStorage.setItem('advence.theme', t);
  } catch {
    /* ignore */
  }
}

function initialTheme(): Theme {
  try {
    const t = localStorage.getItem('advence.theme');
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch {
    /* ignore */
  }
  return 'dark';
}

function deviceName(): string {
  const p = platform().platform;
  const names: Record<string, string> = { windows: 'Windows PC', macos: 'Mac', linux: 'Linux PC', android: 'Android phone', browser: 'Web browser' };
  return names[p] ?? 'Device';
}

export const useStore = create<State>((set, get) => ({
  phase: 'loading',
  servers: [],
  active: null,
  client: null,
  info: null,
  user: null,
  error: null,
  lang: 'en',
  theme: 'dark',

  async init() {
    const lang = initialLang();
    applyLang(lang);
    const theme = initialTheme();
    applyTheme(theme);
    const servers = loadServers();
    const id = activeServerId();
    const active = servers.find((s) => s.id === id) ?? servers[0] ?? null;
    set({ lang, theme, servers, active, client: active ? new ApiClient(active, platform()) : null });
    await get().resolvePhase();
  },

  async addFromLink(text) {
    const link = parseLink(text);
    if (!link) throw new Error('invalid_link');
    const s = serverFromLink(link);
    const client = new ApiClient(s, platform());
    const r = await client.startPairing(link.token, deviceName(), platform().platform);
    const saved: SavedServer = { ...s, deviceId: r.deviceId, pairingId: r.pairingId, pairingCode: r.code };
    const servers = [...get().servers.filter((x) => x.id !== saved.id), saved];
    saveServers(servers);
    setActiveServerId(saved.id);
    get().client?.close();
    set({ servers, active: saved, client: new ApiClient(saved, platform()), error: null });
    // keep the key generated for this pairing
    await get().resolvePhase();
  },

  async switchServer(id) {
    const s = get().servers.find((x) => x.id === id);
    if (!s) return;
    get().client?.close();
    setActiveServerId(id);
    set({ active: s, client: new ApiClient(s, platform()), user: null, info: null, phase: 'loading' });
    await get().resolvePhase();
  },

  async removeServer(id) {
    const s = get().servers.find((x) => x.id === id);
    if (s) await new ApiClient(s, platform()).forgetKey();
    const servers = get().servers.filter((x) => x.id !== id);
    saveServers(servers);
    if (get().active?.id === id) {
      get().client?.close();
      const next = servers[0] ?? null;
      setActiveServerId(next?.id ?? null);
      set({ servers, active: next, client: next ? new ApiClient(next, platform()) : null, user: null });
      await get().resolvePhase();
    } else set({ servers });
  },

  showConnect() {
    set({ phase: 'connect' });
  },

  async resolvePhase() {
    const { active, client } = get();
    if (!active || !client) return set({ phase: 'connect' });
    if (active.state === 'pairing') return set({ phase: 'pairing' });
    try {
      const info = await client.serverInfo();
      set({ info });
      try {
        await client.refresh();
        set({ user: client.user, phase: 'ready', error: null });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'login_required') {
          set({ phase: info.setupRequired ? 'setup' : 'login' });
        } else if (e instanceof ApiError && (e.code === 'device_revoked' || e.code === 'unknown_device')) {
          set({ error: 'revoked' });
          await get().removeServer(active.id);
        } else throw e;
      }
    } catch (e) {
      set({ phase: 'connect', error: String((e as Error).message ?? e) });
    }
  },

  setUser(u) {
    set({ user: u, phase: 'ready' });
  },

  updateServer(s) {
    const servers = get().servers.map((x) => (x.id === s.id ? s : x));
    saveServers(servers);
    set({ servers, active: get().active?.id === s.id ? s : get().active });
    const c = get().client;
    if (c && c.server.id === s.id) Object.assign(c.server, s);
  },

  async signOut() {
    const c = get().client;
    try {
      await c?.call('POST', '/v1/auth/logout', {});
    } catch {
      /* ignore */
    }
    c?.close();
    if (c) c.token = '';
    set({ user: null, phase: 'login' });
  },

  setLang(l) {
    applyLang(l);
    set({ lang: l });
  },

  setTheme(t) {
    applyTheme(t);
    set({ theme: t });
  },

  setError(e) {
    set({ error: e });
  },
}));
