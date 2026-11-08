// P7 screens and the Android update check: Settings → Updates (FR-CLI-05, D-24, NFR-REL-02) and
// Settings → Browser UI (FR-CLI-04, D-16).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { randomBytes, createHash } from 'node:crypto';
import { releasePublicKey, signRelease } from '@advence/protocol';
import { applyLang } from './i18n';
import { setPlatform } from './platform';
import { browserBridge } from './platform/browser';
import { useChat } from './state/chat';
import { useStore } from './state/store';
import { BrowserUiSection, UpdatesSection, type ServerUpdateStatus } from './screens/UpdateSettings';
import { checkAppUpdate, installAppUpdate, type AppUpdatePluginApi } from './lib/app-update';
import type { ApiClient } from './api/client';

type Call = { method: string; path: string; body?: unknown };
function fakeClient(handler: (c: Call) => unknown) {
  const calls: Call[] = [];
  const client = {
    calls,
    async call(method: string, path: string, body?: unknown) {
      const c = { method, path, body };
      calls.push(c);
      return handler(c);
    },
  };
  return client as unknown as ApiClient & { calls: Call[] };
}

const status = (o: Partial<ServerUpdateStatus> = {}): ServerUpdateStatus => ({
  current: '1.0.0', enabled: true, canApply: true, available: null, checkedAt: Date.now(), error: null, staged: null, lastFailed: null, ...o,
});

beforeEach(() => {
  act(() => applyLang('en'));
  setPlatform({ ...browserBridge(), notify: vi.fn() });
  useStore.setState({ user: { role: 'owner' } as never });
});
afterEach(() => cleanup());

describe('FR-CLI-05 Settings → Updates (server, owner)', () => {
  it('shows the version, checks, and installs a newer signed release, then says it restarts', async () => {
    let st = status();
    const client = fakeClient(({ method, path }) => {
      if (method === 'GET' && path === '/v1/update') return st;
      if (method === 'POST' && path === '/v1/update/check') return (st = status({ available: { version: '1.1.0', notes: 'Faster replies' } }));
      if (method === 'POST' && path === '/v1/update/apply') return { ok: true, version: '1.1.0' };
      return {};
    });
    useChat.setState({ client } as never);
    render(<UpdatesSection />);
    expect(await screen.findByText('1.0.0')).toBeTruthy();
    expect(screen.getByText('Up to date.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Version 1.1.0 is available.')).toBeTruthy();
    expect(screen.getByText('Faster replies')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Install and restart/ }));
    expect(await screen.findByText(/Installing 1.1.0/)).toBeTruthy();
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/update', 'POST /v1/update/check', 'POST /v1/update/apply']);
  });

  it('shows a rollback, a rejected signature, and why a dev server cannot install', async () => {
    const client = fakeClient(() => status({ canApply: false, available: { version: '1.1.0', notes: '' }, error: 'bad_signature', lastFailed: { version: '1.0.5', from: '1.0.0', at: '', reason: 'exited with 1' } }));
    useChat.setState({ client } as never);
    render(<UpdatesSection />);
    expect(await screen.findByText(/update to 1.0.5 failed its health check and the server went back to 1.0.0/)).toBeTruthy();
    expect(screen.getByText(/not signed with this server's release key/)).toBeTruthy();
    expect(screen.getByText(/not running as an installed service/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install and restart/ })).toBeNull();
  });

  it('members do not see server updates; desktop says it updates itself', async () => {
    useStore.setState({ user: { role: 'member' } as never });
    const client = fakeClient(() => status());
    useChat.setState({ client } as never);
    setPlatform({ ...browserBridge(), notify: vi.fn(), selfUpdating: true });
    render(<UpdatesSection />);
    expect(screen.getByText(/checks for updates by itself/)).toBeTruthy();
    expect(client.calls).toEqual([]);
  });

  it('works in Hebrew', async () => {
    act(() => applyLang('he'));
    useChat.setState({ client: fakeClient(() => status({ available: { version: '2.0.0', notes: '' } })) } as never);
    render(<UpdatesSection />);
    expect(await screen.findByText('גרסה 2.0.0 זמינה.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /התקנה והפעלה מחדש/ })).toBeTruthy();
  });
});

describe('FR-CLI-05 Android: the app update is verified against the pinned key', () => {
  const u8 = (b: Uint8Array) => Uint8Array.from(b);
  const seed = u8(randomBytes(32));
  const apk = randomBytes(2048);
  const file = { name: 'stellarcortex-advence-1.1.0-universal.apk', sha256: createHash('sha256').update(apk).digest('hex'), size: apk.length };
  function plugin(o: { versionCode?: number; signWith?: Uint8Array; keys?: string; edit?: boolean; component?: string } = {}) {
    const manifest = Buffer.from(JSON.stringify({ product: 'stellarcortex-advence', component: o.component ?? 'android', version: '1.1.0', versionCode: 11, createdAt: '', notes: 'New', files: [{ name: 'x-arm64-v8a.apk', sha256: 'c'.repeat(64), size: 5 }, file] }));
    const sig = signRelease(o.signWith ?? seed, u8(manifest));
    const served = o.edit ? Buffer.from(manifest.toString().replace('"New"', '"Evil"')) : manifest;
    const install = vi.fn(async () => undefined);
    const p: AppUpdatePluginApi = {
      info: async () => ({ feedUrl: 'https://updates.example.org', releaseKeys: o.keys ?? releasePublicKey(seed), versionCode: o.versionCode ?? 10, versionName: '1.0.0' }),
      fetchManifest: async ({ file: f }) => ({ base64: f === 'manifest.json' ? served.toString('base64') : Buffer.from(sig).toString('base64') }),
      install,
    };
    return { p, install };
  }

  it('finds the newer signed APK (universal) and passes only the signed name, hash and size to the installer', async () => {
    const { p, install } = plugin();
    const u = await checkAppUpdate(p);
    expect(u).toMatchObject({ version: '1.1.0', notes: 'New', file });
    await installAppUpdate(p, u!);
    expect(install).toHaveBeenCalledWith(file);
  });

  it('rejects another key, an edited manifest and a manifest for another component; ignores older and unconfigured builds', async () => {
    await expect(checkAppUpdate(plugin({ signWith: u8(randomBytes(32)) }).p)).rejects.toMatchObject({ code: 'bad_signature' });
    await expect(checkAppUpdate(plugin({ edit: true }).p)).rejects.toMatchObject({ code: 'bad_signature' });
    await expect(checkAppUpdate(plugin({ component: 'desktop' }).p)).rejects.toMatchObject({ code: 'wrong_component' });
    expect(await checkAppUpdate(plugin({ versionCode: 11 }).p)).toBeNull();
    expect(await checkAppUpdate(plugin({ keys: '' }).p)).toBeNull();
  });
});

describe('FR-CLI-04 Settings → Browser UI', () => {
  it('shows the current setting (off by default) and turns it on', async () => {
    let on = false;
    const client = fakeClient(({ method, body }) => {
      if (method === 'PATCH') on = (body as { browserUi: boolean }).browserUi;
      return { browserUi: on, serverName: 'x' };
    });
    useChat.setState({ client } as never);
    render(<BrowserUiSection />);
    const sw = (await screen.findByRole('switch', { name: /Allow signing in from a web browser/ })) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(sw.checked).toBe(true));
    expect(client.calls.at(-1)).toEqual({ method: 'PATCH', path: '/v1/settings', body: { browserUi: true } });
  });
});
