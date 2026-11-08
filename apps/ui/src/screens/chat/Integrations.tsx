// What MCP servers and Google need from the user while the app is open (FR-MCP-02/03,
// FR-GGL-04/05): input requests from a Bot's tool call (form or URL), the Google connect step
// after login, the day-6 reconnect reminder, and the "paste the address" step of an OAuth flow
// on clients without a loopback receiver.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HeldAction, McpInput, Suggestion } from '@advence/protocol';
import { useIntegrations } from '../../state/integrations';
import { useProactive } from '../../state/proactive';
import { useChat } from '../../state/chat';
import { platform } from '../../platform';
import { Icon } from '../../ui/Icon';
import { useErr } from './ChatSettings';

type Field = {
  type?: string; title?: string; description?: string; default?: unknown; format?: string;
  enum?: string[]; enumNames?: string[]; oneOf?: { const: string; title?: string }[];
  items?: { enum?: string[]; anyOf?: { const: string; title?: string }[]; oneOf?: { const: string; title?: string }[] };
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number;
};

function options(f: Field): { value: string; label: string }[] | null {
  if (f.oneOf) return f.oneOf.map((o) => ({ value: o.const, label: o.title ?? o.const }));
  if (f.enum) return f.enum.map((v, i) => ({ value: v, label: f.enumNames?.[i] ?? v }));
  return null;
}

function itemOptions(f: Field): { value: string; label: string }[] | null {
  const it = f.items;
  if (!it) return null;
  const list = it.anyOf ?? it.oneOf;
  if (list) return list.map((o) => ({ value: o.const, label: o.title ?? o.const }));
  return it.enum ? it.enum.map((v) => ({ value: v, label: v })) : null;
}

const INPUT_TYPE: Record<string, string> = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' };

/** A form a server asked for: flat fields of the types form-mode elicitation allows. */
function InputForm({ input, onDone }: { input: McpInput; onDone(): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const answer = useIntegrations((s) => s.answerInput);
  const schema = (input.schema ?? {}) as { properties?: Record<string, Field>; required?: string[] };
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  const [vals, setVals] = useState<Record<string, unknown>>(() => Object.fromEntries(props.filter(([, f]) => f.default !== undefined).map(([k, f]) => [k, f.default])));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setVals((x) => ({ ...x, [k]: v }));
  const send = async (action: 'accept' | 'decline' | 'cancel') => {
    setBusy(true);
    setErr(null);
    try {
      await answer(input.id, action === 'accept' ? { action, content: vals } : { action });
      onDone();
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void send('accept'); }}>
      {props.map(([k, f]) => {
        const id = `inp-${input.id}-${k}`;
        const label = `${f.title ?? k}${required.has(k) ? ' *' : ''}`;
        const opts = options(f);
        const multi = f.type === 'array' ? itemOptions(f) : null;
        if (f.type === 'boolean') {
          return (
            <label key={k} className="row" htmlFor={id}>
              <input id={id} type="checkbox" checked={vals[k] === true} onChange={(e) => set(k, e.target.checked)} />
              <span>{label}</span>
              {f.description && <span className="faint" style={{ fontSize: 12 }}>{f.description}</span>}
            </label>
          );
        }
        return (
          <div key={k} className="stack" style={{ gap: 4 }}>
            <label htmlFor={id}>{label}</label>
            {f.description && <span className="faint" style={{ fontSize: 12 }}>{f.description}</span>}
            {multi ? (
              <div id={id} role="group" aria-label={label} className="row wrap">
                {multi.map((o) => {
                  const cur = (vals[k] as string[] | undefined) ?? [];
                  return (
                    <label key={o.value} className="row" style={{ gap: 4 }}>
                      <input type="checkbox" checked={cur.includes(o.value)} onChange={(e) => set(k, e.target.checked ? [...cur, o.value] : cur.filter((x) => x !== o.value))} />
                      {o.label}
                    </label>
                  );
                })}
              </div>
            ) : opts ? (
              <select id={id} className="input" value={String(vals[k] ?? '')} onChange={(e) => set(k, e.target.value)} required={required.has(k)}>
                <option value="" disabled>{t('mcp.input.choose')}</option>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.type === 'number' || f.type === 'integer' ? (
              <input id={id} className="input" type="number" step={f.type === 'integer' ? 1 : 'any'} min={f.minimum} max={f.maximum} value={vals[k] === undefined ? '' : String(vals[k])} onChange={(e) => set(k, e.target.value === '' ? undefined : Number(e.target.value))} required={required.has(k)} />
            ) : (
              <input id={id} className="input" type={INPUT_TYPE[f.format ?? ''] ?? 'text'} minLength={f.minLength} maxLength={f.maxLength} value={String(vals[k] ?? '')} onChange={(e) => set(k, e.target.value)} required={required.has(k)} />
            )}
          </div>
        );
      })}
      <p className="notice" style={{ margin: 0 }}><Icon name="shield" size={16} /> {t('mcp.input.noSecrets')}</p>
      {err && <div role="alert" className="error">{err}</div>}
      <div className="row wrap">
        <button className="btn primary" type="submit" disabled={busy}>{t('mcp.input.send')}</button>
        <button className="btn" type="button" onClick={() => void send('decline')} disabled={busy}>{t('mcp.input.decline')}</button>
        <button className="btn ghost" type="button" onClick={() => void send('cancel')} disabled={busy}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

/** URL mode: the full address is shown and opened only after the user agrees. */
function InputUrl({ input, onDone }: { input: McpInput; onDone(): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const answer = useIntegrations((s) => s.answerInput);
  const [opened, setOpened] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const host = (() => {
    try {
      return new URL(input.url ?? '').host;
    } catch {
      return '';
    }
  })();
  const send = async (action: 'accept' | 'decline' | 'cancel') => {
    try {
      await answer(input.id, { action });
      onDone();
    } catch (e) {
      setErr(toErr(e));
    }
  };
  return (
    <div className="stack">
      <p style={{ margin: 0 }}>{t('mcp.input.urlIntro', { host })}</p>
      <code className="mono" dir="ltr" style={{ wordBreak: 'break-all', fontSize: 12 }}>{input.url}</code>
      {err && <div role="alert" className="error">{err}</div>}
      <div className="row wrap">
        {!opened ? (
          <button className="btn primary" onClick={() => { platform().openExternal(input.url!); setOpened(true); }}><Icon name="link" /> {t('mcp.input.open', { host })}</button>
        ) : (
          <button className="btn primary" onClick={() => void send('accept')}><Icon name="check" /> {t('mcp.input.done')}</button>
        )}
        <button className="btn" onClick={() => void send('decline')}>{t('mcp.input.decline')}</button>
      </div>
    </div>
  );
}

export function InputCard({ input }: { input: McpInput }) {
  const { t } = useTranslation();
  const bot = useChat((s) => s.botById(input.botId));
  const [, done] = useState(0);
  return (
    <section className="card stack" aria-label={t('mcp.input.title', { server: input.serverName })}>
      <div className="row wrap">
        <Icon name="mcp" />
        <strong className="spacer">{t('mcp.input.title', { server: input.serverName })}</strong>
        {bot && <span className="badge">{bot.name}</span>}
      </div>
      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{input.message}</p>
      {input.mode === 'url' ? <InputUrl input={input} onDone={() => done((n) => n + 1)} /> : <InputForm input={input} onDone={() => done((n) => n + 1)} />}
    </section>
  );
}

/** The last step of an OAuth flow on the browser UI and Android. */
export function PasteCard() {
  const { t } = useTranslation();
  const toErr = useErr();
  const { paste, setPaste } = useIntegrations();
  const [v, setV] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!paste) return null;
  return (
    <section className="card stack" aria-label={t('oauth.pasteTitle', { name: paste.title })}>
      <strong>{t('oauth.pasteTitle', { name: paste.title })}</strong>
      <p className="dim" style={{ margin: 0 }}>{t('oauth.pasteHelp')}</p>
      <form className="stack" onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        void paste.finish(v.trim()).then(() => { setPaste(null); setV(''); }, (x) => setErr(toErr(x)));
      }}>
        <input className="input mono" dir="ltr" aria-label={t('oauth.pasteTitle', { name: paste.title })} placeholder="http://localhost:47823/oauth/callback?code=…" value={v} onChange={(e) => setV(e.target.value)} />
        {err && <div role="alert" className="error">{err}</div>}
        <div className="row">
          <button className="btn primary" type="submit" disabled={!v}>{t('common.confirm')}</button>
          <button className="btn ghost" type="button" onClick={() => setPaste(null)}>{t('common.cancel')}</button>
        </div>
      </form>
    </section>
  );
}

const PROMPT_KEY = 'advence.googlePrompt.dismissed';

/** Right after login: connect Google in one consent. Later: the day-6 reminder and "reconnect". */
function GoogleCard({ openSettings }: { openSettings(): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const { google, reminder, connectGoogle, dismissReminder } = useIntegrations();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(PROMPT_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!google) return null;
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await connectGoogle();
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(false);
    }
  };
  let text: string;
  if (google.state === 'none' && !dismissed) text = t('google.prompt');
  else if (google.state === 'expiring' && reminder) text = t('google.expiring');
  else if (google.state === 'reconnect') text = t('google.expired');
  else return null;
  return (
    <section className="card stack" aria-label={t('settings.sections.google')} role={google.state === 'reconnect' ? 'alert' : undefined}>
      <div className="row"><Icon name="globe" /><strong>{t('settings.sections.google')}</strong></div>
      <p style={{ margin: 0 }}>{text}</p>
      {err && <div role="alert" className="error">{err}</div>}
      <div className="row wrap">
        <button className="btn primary" onClick={() => void go()} disabled={busy}>{google.state === 'none' ? t('google.connect') : t('google.reconnect')}</button>
        <button className="btn ghost" onClick={openSettings}>{t('nav.settings')}</button>
        {google.state !== 'reconnect' && (
          <button className="btn ghost" onClick={() => {
            if (google.state === 'none') {
              try {
                localStorage.setItem(PROMPT_KEY, '1');
              } catch {
                /* private mode */
              }
              setDismissed(true);
            } else dismissReminder();
          }}>{t('google.later')}</button>
        )}
      </div>
    </section>
  );
}

/** A proactive Bot's suggestion: one tap runs it start to finish (FR-PRO-04). */
export function SuggestionCard({ s }: { s: Suggestion }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const bot = useChat((x) => x.botById(s.botId));
  const { runSuggestion, dismissSuggestion } = useProactive();
  const [err, setErr] = useState<string | null>(null);
  const act = (fn: () => Promise<void>) => {
    setErr(null);
    void fn().catch((e) => setErr(toErr(e)));
  };
  return (
    <section className="card stack" aria-label={t('proactive.suggestion', { title: s.title })}>
      <div className="row wrap">
        <Icon name="sparkle" />
        <strong className="spacer bidi">{s.title}</strong>
        {bot && <span className="badge">{bot.name}</span>}
      </div>
      {s.detail && <p className="dim bidi" style={{ margin: 0 }}>{s.detail}</p>}
      {err && <div role="alert" className="error">{err}</div>}
      <div className="row">
        {s.status === 'running' ? <span className="dim" role="status">{t('proactive.running')}</span> : (
          <>
            <button className="btn primary" onClick={() => act(() => runSuggestion(s.id))}><Icon name="play" size={16} /> {t('proactive.doIt')}</button>
            <button className="btn ghost" onClick={() => act(() => dismissSuggestion(s.id))}>{t('proactive.dismiss')}</button>
          </>
        )}
      </div>
    </section>
  );
}

/** A Bot that is not proactive read outside content, then wanted to act: the user decides (NFR-SEC-11). */
export function HeldCard({ h }: { h: HeldAction }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const bot = useChat((x) => x.botById(h.botId));
  const decide = useProactive((x) => x.decide);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  let pretty = h.input;
  try {
    pretty = JSON.stringify(JSON.parse(h.input), null, 2);
  } catch {
    /* shown as sent */
  }
  const go = (allow: boolean) => {
    setBusy(true);
    setErr(null);
    void decide(h.id, allow).catch((e) => setErr(toErr(e))).finally(() => setBusy(false));
  };
  return (
    <section className="card stack" role="alert" aria-label={t('proactive.heldTitle', { bot: bot?.name ?? '' })}>
      <div className="row wrap">
        <Icon name="shield" />
        <strong className="spacer">{t('proactive.heldTitle', { bot: bot?.name ?? '' })}</strong>
      </div>
      <p style={{ margin: 0 }}>{t('proactive.heldHelp')}</p>
      <div className="stack" style={{ gap: 4 }}>
        <span className="label">{t('proactive.heldTool', { tool: h.tool })}</span>
        <pre className="mono" dir="ltr" style={{ margin: 0, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-elev-2)', padding: 8, borderRadius: 'var(--radius-sm)' }}>{pretty}</pre>
      </div>
      {err && <div role="alert" className="error">{err}</div>}
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => go(true)}>{t('proactive.allow')}</button>
        <button className="btn primary" disabled={busy} onClick={() => go(false)}>{t('proactive.deny')}</button>
      </div>
    </section>
  );
}

/** Shown above the main area: whatever is waiting on the user. */
export function IntegrationTray({ openSettings }: { openSettings(section: 'google' | 'mcp'): void }) {
  const inputs = useIntegrations((s) => s.inputs);
  const { held, suggestions } = useProactive();
  const activeConv = useChat((s) => s.activeConv);
  // The active chat's requests first.
  const sorted = [...inputs].sort((a, b) => Number(b.convId === activeConv) - Number(a.convId === activeConv) || a.createdAt - b.createdAt);
  return (
    <div className="tray stack">
      <GoogleCard openSettings={() => openSettings('google')} />
      <PasteCard />
      {held.map((h) => <HeldCard key={h.id} h={h} />)}
      {sorted.map((i) => <InputCard key={i.id} input={i} />)}
      {suggestions.slice(0, 5).map((s) => <SuggestionCard key={s.id} s={s} />)}
    </div>
  );
}
