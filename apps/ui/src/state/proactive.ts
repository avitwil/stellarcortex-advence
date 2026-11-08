// Proactive Bots in the app (P6): routines and their runs (FR-UI-06), suggestion cards
// (FR-PRO-04), actions held for approval (NFR-SEC-11) and the global pause (FR-PRO-06).
import { create } from 'zustand';
import { PROACTIVE_EVENTS, type HeldAction, type Routine, type RoutineRun, type Suggestion, type Trigger } from '@advence/protocol';
import type { ApiClient } from '../api/client';
import { platform } from '../platform';

export interface NewRoutine { botId: string; name: string; instructions: string; trigger: Trigger }

interface ProactiveState {
  client: ApiClient | null;
  paused: boolean;
  routines: Routine[];
  runs: Record<string, RoutineRun[]>;
  suggestions: Suggestion[];
  held: HeldAction[];
  /** the webhook address shown once, right after creating a webhook routine */
  freshHook: { id: string; url: string } | null;
  attach(client: ApiClient | null): () => void;
  load(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  create(r: NewRoutine): Promise<Routine>;
  patch(id: string, p: Partial<Pick<Routine, 'name' | 'instructions' | 'trigger' | 'paused'>>): Promise<void>;
  remove(id: string): Promise<void>;
  runNow(id: string): Promise<void>;
  loadRuns(id: string): Promise<void>;
  runSuggestion(id: string): Promise<void>;
  dismissSuggestion(id: string): Promise<void>;
  decide(id: string, allow: boolean): Promise<void>;
  clearFreshHook(): void;
}

const upsert = <T extends { id: string }>(list: T[], x: T) => (list.some((y) => y.id === x.id) ? list.map((y) => (y.id === x.id ? x : y)) : [...list, x]);

export const useProactive = create<ProactiveState>((set, get) => ({
  client: null,
  paused: false,
  routines: [],
  runs: {},
  suggestions: [],
  held: [],
  freshHook: null,

  attach(client) {
    set({ client, paused: false, routines: [], runs: {}, suggestions: [], held: [], freshHook: null });
    if (!client) return () => undefined;
    void get().load();
    const sock = client.openSocket();
    const offState = sock.onState((s) => s === 'open' && void get().load());
    const off = sock.onEvent((event, data) => {
      if (event === PROACTIVE_EVENTS.state) set({ paused: (data as { paused: boolean }).paused });
      else if (event === PROACTIVE_EVENTS.routine) {
        const r = data as Routine & { deleted?: boolean };
        set((s) => ({ routines: r.deleted ? s.routines.filter((x) => x.id !== r.id) : upsert(s.routines, { ...r, webhookUrl: s.routines.find((x) => x.id === r.id)?.webhookUrl ?? r.webhookUrl }) }));
      } else if (event === PROACTIVE_EVENTS.run) {
        const run = data as RoutineRun;
        if (!run.routineId) return;
        set((s) => {
          const list = s.runs[run.routineId!] ?? [];
          const next = list.some((x) => x.id === run.id) ? list.map((x) => (x.id === run.id ? run : x)) : [run, ...list];
          const routines = s.routines.map((r) => (r.id === run.routineId ? { ...r, lastRun: { at: run.startedAt, status: run.status } } : r));
          return { runs: { ...s.runs, [run.routineId!]: next }, routines };
        });
      } else if (event === PROACTIVE_EVENTS.suggestion) {
        const x = data as Suggestion;
        const visible = x.status === 'open' || x.status === 'running';
        const isNew = visible && !get().suggestions.some((y) => y.id === x.id);
        set((s) => ({ suggestions: (visible ? upsert(s.suggestions, x) : s.suggestions.filter((y) => y.id !== x.id)).sort((a, b) => b.rank - a.rank || b.createdAt - a.createdAt) }));
        if (isNew) platform().notify(x.title, x.detail);
      } else if (event === PROACTIVE_EVENTS.held) {
        const h = data as HeldAction & { done?: boolean };
        set((s) => ({ held: h.done ? s.held.filter((y) => y.id !== h.id) : upsert(s.held, h) }));
      }
    });
    return () => {
      off();
      offState();
    };
  },

  async load() {
    const c = get().client;
    if (!c) return;
    const [st, r, sg, h] = await Promise.all([
      c.call<{ paused: boolean }>('GET', '/v1/proactive').catch(() => ({ paused: false })),
      c.call<{ routines: Routine[] }>('GET', '/v1/routines').catch(() => ({ routines: [] as Routine[] })),
      c.call<{ suggestions: Suggestion[] }>('GET', '/v1/suggestions').catch(() => ({ suggestions: [] as Suggestion[] })),
      c.call<{ held: HeldAction[] }>('GET', '/v1/held').catch(() => ({ held: [] as HeldAction[] })),
    ]);
    set({ paused: st.paused, routines: r.routines, suggestions: sg.suggestions, held: h.held });
  },

  async setPaused(paused) {
    const c = get().client;
    if (c) set({ paused: (await c.call<{ paused: boolean }>('PUT', '/v1/proactive', { paused })).paused });
  },

  async create(r) {
    const c = get().client!;
    const out = await c.call<Routine>('POST', '/v1/routines', r);
    set((s) => ({ routines: upsert(s.routines, out), freshHook: out.webhookUrl && !out.webhookUrl.endsWith('/…') ? { id: out.id, url: out.webhookUrl } : null }));
    return out;
  },

  async patch(id, p) {
    const c = get().client;
    if (!c) return;
    const out = await c.call<Routine>('PATCH', `/v1/routines/${id}`, p);
    set((s) => ({ routines: upsert(s.routines, out) }));
  },

  async remove(id) {
    const c = get().client;
    if (!c) return;
    await c.call('DELETE', `/v1/routines/${id}`);
    set((s) => ({ routines: s.routines.filter((x) => x.id !== id) }));
  },

  async runNow(id) {
    const c = get().client;
    if (!c) return;
    const run = await c.call<RoutineRun>('POST', `/v1/routines/${id}/run`);
    set((s) => ({ runs: { ...s.runs, [id]: [run, ...(s.runs[id] ?? []).filter((x) => x.id !== run.id)] } }));
  },

  async loadRuns(id) {
    const c = get().client;
    if (!c) return;
    const r = await c.call<{ runs: RoutineRun[] }>('GET', `/v1/routines/runs?routineId=${encodeURIComponent(id)}`);
    set((s) => ({ runs: { ...s.runs, [id]: r.runs } }));
  },

  async runSuggestion(id) {
    const c = get().client;
    if (!c) return;
    const x = await c.call<Suggestion>('POST', `/v1/suggestions/${id}/run`);
    set((s) => ({ suggestions: upsert(s.suggestions, x) }));
  },

  async dismissSuggestion(id) {
    const c = get().client;
    if (!c) return;
    await c.call('POST', `/v1/suggestions/${id}/dismiss`);
    set((s) => ({ suggestions: s.suggestions.filter((x) => x.id !== id) }));
  },

  async decide(id, allow) {
    const c = get().client;
    if (!c) return;
    await c.call('POST', `/v1/held/${id}`, { allow });
    set((s) => ({ held: s.held.filter((x) => x.id !== id) }));
  },

  clearFreshHook() {
    set({ freshHook: null });
  },
}));
