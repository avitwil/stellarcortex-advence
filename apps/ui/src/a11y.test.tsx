// NFR-A11Y-01: keyboard navigation and screen-reader labels on all main screens. axe-core audits
// each screen (in English and Hebrew) and the test fails on any critical violation. Colour
// contrast needs real layout, which jsdom has not, so it is part of MC-P7-A11Y.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { applyLang } from './i18n';
import { setPlatform } from './platform';
import { browserBridge } from './platform/browser';
import { useStore } from './state/store';
import { ApiError, type ApiClient } from './api/client';
import { ConnectScreen } from './screens/Connect';
import { LoginScreen } from './screens/Login';
import { PairingScreen } from './screens/Pairing';
import { SetupScreen } from './screens/Setup';
import { Shell } from './screens/Shell';

const now = Date.now();
const bot = { id: 'b1', name: 'Scout', avatar: '', instructions: '', sourceId: 's1', model: 'm', engine: 'opencode', tools: ['code', 'computer'], primary: true, proactive: true, paused: false, hostControl: false, notify: 'all', createdAt: 1 };
const conv = { id: 'c1', kind: 'direct', title: 'Scout', botIds: ['b1'], updatedAt: now, lastPreview: 'Hello', unread: 1 };
const msg = (id: string, author: 'user' | 'bot', text: string) => ({ id, conversationId: 'c1', author, userId: author === 'user' ? 'u1' : null, botId: author === 'bot' ? 'b1' : null, text, parentId: null, attachments: [], mentions: [], reactions: [], status: 'done', error: null, replyCount: 0, createdAt: now });
const limits = { cpus: 2, memoryMb: 3072, diskGb: 20 };

const fixtures: [RegExp, unknown][] = [
  [/^GET \/v1\/bots$/, [bot]],
  [/^GET \/v1\/conversations$/, [conv]],
  [/^GET \/v1\/conversations\/c1\/messages/, [msg('m1', 'user', 'Find the report'), msg('m2', 'bot', 'Here is the **report**.')]],
  [/^GET \/v1\/conversations\/c1\/draft/, { text: '' }],
  [/^GET \/v1\/notifications$/, { pushServer: null, muted: false, registered: false }],
  [/^GET \/v1\/sources$/, [{ id: 's1', kind: 'openai', name: 'OpenAI', baseUrl: null, hasKey: true, createdAt: 1 }]],
  [/^GET \/v1\/bots\/b1\/computer$/, { botId: 'b1', state: 'running', progress: null, detail: null, takeover: false, gpu: false, limits }],
  [/^GET \/v1\/computer\/settings$/, { runtime: { available: true, version: '5.4', error: null }, image: { present: true, building: false, progress: null, error: null }, autoStart: true, defaults: limits, gpu: false, hostIsolated: true }],
  [/^GET \/v1\/bots\/b1\/activity/, [{ id: 'a1', at: now, kind: 'auto.run', botId: 'b1', params: { trigger: 'schedule' } }]],
  [/^GET \/v1\/activity/, [{ id: 'a1', at: now, kind: 'auto.run', botId: 'b1', params: { trigger: 'schedule' } }]],
  [/^GET \/v1\/library/, [{ id: 'l1', kind: 'link', url: 'https://example.org/report', title: 'Report', botId: 'b1', conversationId: 'c1', messageId: 'm2', createdAt: now }]],
  [/^GET \/v1\/routines$/, { routines: [{ id: 'r1', botId: 'b1', name: 'Morning mail', instructions: 'Answer mail', trigger: { kind: 'schedule', cron: '0 8 * * *', tz: 'UTC' }, paused: false, nextRun: now + 3600_000, lastRun: null, webhookUrl: null, createdAt: 1 }] }],
  [/^GET \/v1\/routines\/runs/, { runs: [] }],
  [/^GET \/v1\/proactive$/, { paused: false }],
  [/^GET \/v1\/suggestions$/, { suggestions: [] }],
  [/^GET \/v1\/held$/, { held: [] }],
  [/^GET \/v1\/google$/, { state: 'none', email: null, services: [], connectedAt: null, expiresAt: null }],
  [/^GET \/v1\/mcp\/inputs$/, []],
  [/^GET \/v1\/mcp\/servers$/, []],
  [/^GET \/v1\/mcp\/self$/, { endpoint: 'https://server:4443/mcp', certPem: '', tokens: [], clientMetadataUrl: null }],
  [/^GET \/v1\/memory$/, { mode: 'encrypted', vaultPath: null, consolidation: false, curator: { staleDays: 30, archiveDays: 90, lastRun: null }, notes: 3, history: [] }],
  [/^GET \/v1\/skills$/, []],
  [/^GET \/v1\/skills\/(reviews|curator)$/, []],
  [/^GET \/v1\/usage$/, []],
  [/^GET \/v1\/devices$/, { devices: [{ id: 'd1', name: 'Laptop', platform: 'linux', createdAt: 1, lastSeen: now, revoked: false, current: true }] }],
  [/^GET \/v1\/pairings$/, { pairings: [] }],
  [/^GET \/v1\/allowlist$/, { entries: [{ email: 'owner@example.com', bound: true }] }],
  [/^GET \/v1\/settings$/, { browserUi: false, serverName: 'Home' }],
  [/^GET \/v1\/setup$/, { webRedirectUri: 'http://localhost:47823/oauth/callback', androidPackage: 'com.stellarcortex.advence', androidSha1: 'AA:BB', scopes: ['openid'], steps: [{ id: 'project', url: 'https://console.cloud.google.com/' }, { id: 'paste' }] }],
  [/^GET \/v1\/update$/, { current: '1.0.0', enabled: true, canApply: true, available: { version: '1.1.0', notes: 'Notes' }, checkedAt: now, error: null, staged: null, lastFailed: null }],
];

function fakeClient(): ApiClient {
  const call = async (method: string, path: string) => {
    const key = `${method} ${path}`;
    const hit = fixtures.find(([re]) => re.test(key));
    if (hit) return structuredClone(hit[1]);
    if (method === 'GET') throw new ApiError(404, 'not_found');
    return {};
  };
  return {
    call,
    raw: call,
    openSocket: () => ({ onState: () => () => undefined, onEvent: () => () => undefined, close: () => undefined }),
  } as unknown as ApiClient;
}

/** Runs axe on what is on screen; returns the critical violations with their targets. */
async function audit(label: string): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  if (process.env.A11Y_DEBUG) console.log('AUDIT', label, r.violations.map((v) => `${v.impact}:${v.id}:${v.nodes.length}:${v.nodes[0]?.target.join(' ')}`).join(' | '));
  return r.violations.filter((v) => v.impact === 'critical').map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

beforeEach(() => {
  setPlatform({ ...browserBridge(), notify: vi.fn(), canScanQr: true });
  useStore.setState({ client: fakeClient(), user: { id: 'u1', email: 'owner@example.com', name: 'Owner', role: 'owner' } as never });
});
afterEach(() => cleanup());

describe.each(['en', 'he'] as const)('NFR-A11Y-01 axe audit has no criticals (%s)', (lang) => {
  beforeEach(() => act(() => applyLang(lang)));

  it('sign-in, connect, pairing and setup screens', async () => {
    const found: string[] = [];
    for (const [name, El] of [['connect', ConnectScreen], ['login', LoginScreen], ['pairing', PairingScreen], ['setup', SetupScreen]] as const) {
      render(<El />);
      await settle();
      found.push(...(await audit(name)));
      cleanup();
    }
    expect(found).toEqual([]);
  });

  it('chat home, a conversation, Library, Activity, Routines and every Settings section', async () => {
    const found: string[] = [];
    render(<Shell />);
    await settle();
    found.push(...(await audit('home')));
    // Open the conversation from the sidebar with the keyboard-reachable button.
    const open = await screen.findAllByRole('button', { name: /Scout/ });
    fireEvent.click(open[0]!);
    await settle();
    await waitFor(() => expect(screen.getAllByText(/report/).length).toBeGreaterThan(0));
    found.push(...(await audit('conversation')));
    for (const name of [/Library|ספרייה/, /Activity|פעילות/, /Routines|שגרות/]) {
      const btn = screen.queryAllByRole('button', { name }).at(0) ?? screen.queryAllByRole('link', { name }).at(0);
      if (!btn) continue;
      fireEvent.click(btn);
      await settle();
      found.push(...(await audit(String(name))));
    }
    const settingsBtn = screen.getAllByRole('button', { name: /Settings|הגדרות/ })[0]!;
    fireEvent.click(settingsBtn);
    await settle();
    const nav = screen.getByRole('navigation');
    const sections = [...nav.querySelectorAll('button.nav-item')] as HTMLButtonElement[];
    expect(sections.length).toBeGreaterThan(10);
    for (const s of sections) {
      fireEvent.click(s);
      await settle();
      found.push(...(await audit(`settings ${s.textContent?.trim()}`)));
    }
    expect(found).toEqual([]);
  });
});

describe('NFR-A11Y-01 keyboard and labels', () => {
  it('the audit itself catches a button without a name', async () => {
    render(<div><button type="button" /><input type="text" /></div>);
    expect((await audit('probe')).some((v) => v.includes('button-name'))).toBe(true);
  });

  it('every button and input on the main screens has an accessible name and can take focus', async () => {
    act(() => applyLang('en'));
    render(<Shell />);
    await settle();
    const r = await axe.run(document.body, { runOnly: { type: 'rule', values: ['button-name', 'label', 'link-name', 'aria-allowed-attr', 'aria-required-attr', 'tabindex'] } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
    const focusables = [...document.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href]')].filter((e) => !e.hasAttribute('disabled'));
    expect(focusables.length).toBeGreaterThan(3);
    for (const el of focusables) expect(el.tabIndex).toBeGreaterThanOrEqual(0);
  });
});
