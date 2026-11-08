// Google services and MCP state for the app (FR-GGL-04/05, FR-MCP-02/03/05): the user's Google
// connection, input requests MCP servers are waiting on, and the shared OAuth step (system
// browser + loopback on desktop, paste on browser and Android).
import { create } from 'zustand';
import { DESKTOP_OAUTH_REDIRECT, randomBytes, sha256, toB64url, type GoogleConnection, type McpInput } from '@advence/protocol';
import type { ApiClient } from '../api/client';
import { platform } from '../platform';

/** Where an OAuth flow continues once the user pastes the address the browser landed on. */
export interface PasteStep {
  title: string;
  finish(callbackUrl: string): Promise<void>;
}

interface IntegrationsState {
  client: ApiClient | null;
  google: GoogleConnection | null;
  /** set by a day-6 reminder until the user acts on it or dismisses it */
  reminder: boolean;
  inputs: McpInput[];
  paste: PasteStep | null;
  attach(client: ApiClient | null): () => void;
  loadGoogle(): Promise<void>;
  loadInputs(): Promise<void>;
  connectGoogle(): Promise<void>;
  disconnectGoogle(): Promise<void>;
  /** Opens an authorization page; resolves with the callback URL, or asks for a paste. */
  authorize(url: string, title: string, finish: (callbackUrl: string) => Promise<void>): Promise<void>;
  answerInput(id: string, a: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }): Promise<void>;
  dismissReminder(): void;
  setPaste(p: PasteStep | null): void;
}

export const useIntegrations = create<IntegrationsState>((set, get) => ({
  client: null,
  google: null,
  reminder: false,
  inputs: [],
  paste: null,

  attach(client) {
    set({ client, google: null, inputs: [], paste: null, reminder: false });
    if (!client) return () => undefined;
    void get().loadGoogle();
    void get().loadInputs();
    const sock = client.openSocket();
    const offState = sock.onState((s) => {
      if (s === 'open') {
        void get().loadGoogle();
        void get().loadInputs();
      }
    });
    const off = sock.onEvent((event, data) => {
      if (event === 'google.connection') {
        const g = data as GoogleConnection & { reminder?: boolean };
        set({ google: g, reminder: g.reminder ? true : g.state === 'ok' ? false : get().reminder });
        if (g.reminder) platform().notify('Google', g.email ?? '');
      } else if (event === 'mcp.input') {
        const i = data as McpInput & { done?: boolean };
        set((s) => ({ inputs: i.done ? s.inputs.filter((x) => x.id !== i.id) : [...s.inputs.filter((x) => x.id !== i.id), i] }));
      }
    });
    return () => {
      off();
      offState();
    };
  },

  async loadGoogle() {
    const c = get().client;
    if (!c) return;
    try {
      const g = await c.call<GoogleConnection>('GET', '/v1/google');
      set({ google: g, reminder: g.state === 'expiring' || get().reminder });
    } catch {
      /* Google not configured on this server */
    }
  },

  async loadInputs() {
    const c = get().client;
    if (c) set({ inputs: await c.call<McpInput[]>('GET', '/v1/mcp/inputs').catch(() => []) });
  },

  async connectGoogle() {
    const c = get().client;
    if (!c) return;
    const p = platform();
    if (p.googleAuthorize) {
      const info = await c.call<{ clientId: string; scopes: string[] }>('GET', '/v1/google/connect');
      const r = await p.googleAuthorize(info);
      set({ google: await c.call<GoogleConnection>('POST', '/v1/google/connect/finish', { serverAuthCode: r.serverAuthCode }), reminder: false });
      return;
    }
    const verifier = toB64url(randomBytes(32));
    const s = await c.call<{ url: string; state: string }>('POST', '/v1/google/connect/start', { redirectUri: DESKTOP_OAUTH_REDIRECT, codeChallenge: toB64url(sha256(verifier)) });
    await get().authorize(s.url, 'Google', async (cb) => {
      const u = new URL(cb);
      const code = u.searchParams.get('code');
      if (!code || u.searchParams.get('state') !== s.state) throw Object.assign(new Error('state_mismatch'), { code: 'state_mismatch' });
      set({ google: await c.call<GoogleConnection>('POST', '/v1/google/connect/finish', { code, state: s.state, codeVerifier: verifier }), reminder: false });
    });
  },

  async disconnectGoogle() {
    const c = get().client;
    if (c) set({ google: await c.call<GoogleConnection>('DELETE', '/v1/google'), reminder: false });
  },

  async authorize(url, title, finish) {
    const r = await platform().authorize(url);
    if (r === 'paste') {
      set({ paste: { title, finish } });
      return;
    }
    await finish(r.callbackUrl);
  },

  async answerInput(id, a) {
    const c = get().client;
    if (!c) return;
    await c.call('POST', `/v1/mcp/inputs/${id}`, a);
    set((s) => ({ inputs: s.inputs.filter((x) => x.id !== id) }));
  },

  dismissReminder() {
    set({ reminder: false });
  },

  setPaste(p) {
    set({ paste: p });
  },
}));
