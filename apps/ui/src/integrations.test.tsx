// FR-MCP-05 (MCP management from Settings), FR-MCP-02 (form and URL input cards),
// FR-GGL-04/05 (Google prompt, day-6 reminder, reconnect on expiry) against a fake API client.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within, cleanup } from '@testing-library/react';
import type { GoogleConnection, McpInput, McpServer } from '@advence/protocol';
import { applyLang } from './i18n';
import { setPlatform } from './platform';
import { browserBridge } from './platform/browser';
import { useChat } from './state/chat';
import { useStore } from './state/store';
import { useIntegrations } from './state/integrations';
import { McpSection, GoogleSection } from './screens/chat/IntegrationSettings';
import { IntegrationTray } from './screens/chat/Integrations';
import type { ApiClient } from './api/client';

type Call = { method: string; path: string; body?: unknown };

function server(over: Partial<McpServer> = {}): McpServer {
  return {
    id: 'm1', name: 'Tickets', transport: 'http', command: null, url: 'https://tickets.example/mcp', envNames: [], headerNames: ['Authorization'],
    preregistered: false, enabled: true, bots: ['b1'], allow: null, status: 'ok', error: null, era: 'modern', signedIn: false,
    tools: [{ name: 'open_ticket', description: 'Open a ticket', task: false }, { name: 'close_ticket', task: true }],
    resources: 2, prompts: 1, createdAt: 1, ...over,
  };
}

function fakeClient(handler: (c: Call) => unknown) {
  const calls: Call[] = [];
  const client = {
    calls,
    async call(method: string, path: string, body?: unknown) {
      const c = { method, path, body };
      calls.push(c);
      return handler(c);
    },
    openSocket: () => ({ onState: () => () => undefined, onEvent: () => () => undefined }),
  };
  return client as unknown as ApiClient & { calls: Call[] };
}

const bots = [{ id: 'b1', name: 'Chief' }, { id: 'b2', name: 'Coder' }];

beforeEach(() => {
  act(() => applyLang('en'));
  setPlatform({ ...browserBridge(), authorize: async () => ({ callbackUrl: 'http://localhost:47823/oauth/callback?code=c1&state=s1' }), openExternal: vi.fn() });
  useStore.setState({ user: { role: 'member' } as never });
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function withChat(client: ApiClient) {
  useChat.setState({ client, bots: bots as never, activeConv: null });
  useIntegrations.setState({ client, google: null, inputs: [], paste: null, reminder: false });
}

describe('FR-MCP-05 MCP management from Settings', () => {
  it('adds a server for a Bot, toggles Bots, sets the tool allowlist, disables, signs in and removes', async () => {
    let list: McpServer[] = [];
    const client = fakeClient(({ method, path, body }) => {
      if (method === 'GET' && path === '/v1/mcp/servers') return list;
      if (method === 'POST' && path === '/v1/mcp/servers') {
        list = [server({ bots: (body as { bots: string[] }).bots })];
        return list[0];
      }
      if (method === 'POST' && path.endsWith('/auth')) return { url: 'https://auth.tickets.example/authorize?x=1' };
      return {};
    });
    withChat(client);
    render(<McpSection />);
    await screen.findByText('No MCP servers yet.');

    fireEvent.click(screen.getByRole('button', { name: /Add an MCP server/ }));
    const form = screen.getByRole('form', { name: 'Add an MCP server' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Tickets' } });
    fireEvent.change(within(form).getByLabelText('Server address'), { target: { value: 'https://tickets.example/mcp' } });
    fireEvent.change(within(form).getByLabelText(/Headers/), { target: { value: 'Authorization: Bearer abc' } });
    fireEvent.click(within(form).getByLabelText('Chief'));
    fireEvent.click(within(form).getByRole('button', { name: 'Add server' }));

    const card = await screen.findByRole('region', { name: 'Tickets' });
    const add = client.calls.find((c) => c.method === 'POST' && c.path === '/v1/mcp/servers');
    expect(add?.body).toEqual({ name: 'Tickets', transport: 'http', url: 'https://tickets.example/mcp', bots: ['b1'], headers: { Authorization: 'Bearer abc' } });
    expect(within(card).getByText('Connected')).toBeTruthy();
    // header values are never shown
    expect(screen.queryByText(/Bearer abc/)).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: /Details/ }));
    expect(within(card).getByText('Tools (2)')).toBeTruthy();
    fireEvent.click(within(card).getByLabelText('Coder'));
    await waitFor(() => expect(client.calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body) === JSON.stringify({ bots: ['b1', 'b2'] }))).toBe(true));

    fireEvent.click(within(card).getByLabelText('All tools'));
    await waitFor(() => expect(client.calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body) === JSON.stringify({ allow: ['open_ticket', 'close_ticket'] }))).toBe(true));

    list = [server({ allow: ['open_ticket', 'close_ticket'] })];
    fireEvent.click(within(card).getByRole('button', { name: /Check/ }));
    await waitFor(() => expect((within(card).getByLabelText('close_ticket') as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(within(card).getByLabelText('close_ticket'));
    await waitFor(() => expect(client.calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body) === JSON.stringify({ allow: ['open_ticket'] }))).toBe(true));

    fireEvent.click(within(card).getByLabelText('On'));
    await waitFor(() => expect(client.calls.some((c) => c.method === 'PATCH' && JSON.stringify(c.body) === JSON.stringify({ enabled: false }))).toBe(true));

    fireEvent.click(within(card).getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(client.calls.some((c) => c.path === '/v1/mcp/servers/m1/auth/finish')).toBe(true));
    const fin = client.calls.find((c) => c.path === '/v1/mcp/servers/m1/auth/finish');
    expect(fin?.body).toEqual({ callbackUrl: 'http://localhost:47823/oauth/callback?code=c1&state=s1' });

    vi.stubGlobal('confirm', () => true);
    fireEvent.click(within(card).getByRole('button', { name: /Remove/ }));
    await waitFor(() => expect(client.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/mcp/servers/m1')).toBe(true));
    vi.unstubAllGlobals();
    expect(screen.getByText(/Members can add public https servers only/)).toBeTruthy();
  });

  it('asks for a paste on platforms without a loopback and finishes from it', async () => {
    setPlatform({ ...browserBridge(), authorize: async () => 'paste' as const, openExternal: vi.fn() });
    const client = fakeClient(({ method, path }) => {
      if (method === 'GET' && path === '/v1/mcp/servers') return [server({ status: 'auth_required' })];
      if (method === 'POST' && path.endsWith('/auth')) return { url: 'https://auth.tickets.example/authorize' };
      return {};
    });
    withChat(client);
    render(<McpSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    const paste = await screen.findByRole('region', { name: 'Finish signing in to Tickets' });
    fireEvent.change(within(paste).getByRole('textbox'), { target: { value: 'http://localhost:47823/oauth/callback?code=z&state=q' } });
    fireEvent.click(within(paste).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(client.calls.find((c) => c.path === '/v1/mcp/servers/m1/auth/finish')?.body).toEqual({ callbackUrl: 'http://localhost:47823/oauth/callback?code=z&state=q' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Finish signing in to Tickets' })).toBeNull());
  });
});

function input(over: Partial<McpInput>): McpInput {
  return { id: 'i1', serverId: 'm1', serverName: 'Tickets', botId: 'b1', convId: null, mode: 'form', message: 'Pick a project', schema: null, url: null, createdAt: 1, expiresAt: 2, ...over };
}

describe('FR-MCP-02 input requests from MCP servers', () => {
  it('renders a form with defaults and sends the answer', async () => {
    const client = fakeClient(() => ({}));
    withChat(client);
    useIntegrations.setState({
      inputs: [input({
        schema: {
          type: 'object', required: ['project'],
          properties: {
            project: { type: 'string', title: 'Project', enum: ['web', 'app'] },
            notify: { type: 'boolean', title: 'Notify me', default: true },
            count: { type: 'integer', title: 'Count', default: 3 },
          },
        },
      })],
    });
    render(<IntegrationTray openSettings={() => undefined} />);
    const card = screen.getByRole('region', { name: 'Tickets needs something from you' });
    expect(within(card).getByText('Chief')).toBeTruthy();
    expect((within(card).getByLabelText('Notify me') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(within(card).getByLabelText('Project *'), { target: { value: 'app' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.calls[0]).toEqual({ method: 'POST', path: '/v1/mcp/inputs/i1', body: { action: 'accept', content: { notify: true, count: 3, project: 'app' } } }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Tickets needs something from you' })).toBeNull());
  });

  it('shows the full URL and opens it only after the user taps', async () => {
    const openExternal = vi.fn();
    setPlatform({ ...browserBridge(), openExternal });
    const client = fakeClient(() => ({}));
    withChat(client);
    useIntegrations.setState({ inputs: [input({ mode: 'url', message: 'Approve the payment', url: 'https://pay.example/approve?id=7' })] });
    render(<IntegrationTray openSettings={() => undefined} />);
    expect(screen.getByText('https://pay.example/approve?id=7')).toBeTruthy();
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Open pay\.example/ }));
    expect(openExternal).toHaveBeenCalledWith('https://pay.example/approve?id=7');
    fireEvent.click(screen.getByRole('button', { name: /I finished/ }));
    await waitFor(() => expect(client.calls[0]?.body).toEqual({ action: 'accept' }));
  });
});

function google(over: Partial<GoogleConnection>): GoogleConnection {
  return { state: 'ok', email: 'a@example.com', services: ['gmail', 'calendar', 'drive', 'contacts'], missing: [], connectedAt: 1, expiresAt: Date.now() + 86_400_000, ...over } as GoogleConnection;
}

describe('FR-GGL-04/05 Google prompt, reminder and reconnect', () => {
  it('prompts once after login, then shows the day-6 reminder and the reconnect alert', async () => {
    const client = fakeClient(() => ({}));
    withChat(client);
    const connectGoogle = vi.fn(async () => undefined);
    useIntegrations.setState({ google: google({ state: 'none', email: null, services: [] }), connectGoogle });
    const { rerender } = render(<IntegrationTray openSettings={() => undefined} />);
    expect(screen.getByText(/Connect Google so your Bots/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    await waitFor(() => expect(connectGoogle).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText(/Connect Google so your Bots/)).toBeNull();

    act(() => useIntegrations.setState({ google: google({ state: 'expiring' }), reminder: true }));
    rerender(<IntegrationTray openSettings={() => undefined} />);
    expect(screen.getByText(/ends tomorrow/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(connectGoogle).toHaveBeenCalledTimes(2));

    act(() => useIntegrations.setState({ google: google({ state: 'reconnect' }), reminder: false }));
    rerender(<IntegrationTray openSettings={() => undefined} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(/connection has ended/)).toBeTruthy();
    expect(within(alert).queryByRole('button', { name: 'Later' })).toBeNull();
  });

  it('settings show the services, the expiry and the reconnect state', async () => {
    const client = fakeClient(({ path }) => (path === '/v1/google' ? google({ state: 'reconnect', missing: ['drive'], services: ['gmail', 'calendar', 'contacts'] }) : {}));
    withChat(client);
    render(<GoogleSection />);
    expect(await screen.findByText('Reconnect needed')).toBeTruthy();
    expect(screen.getByText(/Some services were not allowed/)).toBeTruthy();
    expect(screen.getByText(/✕ Drive/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });
});
