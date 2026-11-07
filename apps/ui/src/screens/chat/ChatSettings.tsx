// Settings sections added in P2 (FR-UI-07): models and keys, Bots, notifications, usage.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SUBSCRIPTION_KINDS, type Bot, type DeviceLogin, type ModelSource, type ModelSourceKind, type Notifications, type UsageRow,
} from '@advence/protocol';
import { useChat } from '../../state/chat';
import { useStore } from '../../state/store';
import { ApiError } from '../../api/client';
import { Icon } from '../../ui/Icon';
import { platform } from '../../platform';
import { BotEditor } from './BotEditor';
import { BotAvatar } from './BotAvatar';
import { Modal } from './Modal';

const KINDS: ModelSourceKind[] = ['anthropic', 'openai', 'openai-compatible', 'local', 'claude-subscription', 'chatgpt-subscription'];
const OWNER_ONLY: ModelSourceKind[] = ['local', 'claude-subscription', 'chatgpt-subscription'];

function useErr() {
  const { t } = useTranslation();
  return (e: unknown) => (e instanceof ApiError ? t(`errors.${e.code}`, { defaultValue: t('common.error') }) : t('common.error'));
}

export function ModelsSection() {
  const { t } = useTranslation();
  const { sources, loadSources, client } = useChat();
  const [adding, setAdding] = useState(false);
  const [login, setLogin] = useState<ModelSource | null>(null);
  const [token, setToken] = useState<ModelSource | null>(null);
  useEffect(() => void loadSources(), [loadSources]);
  return (
    <div className="stack">
      <p className="dim" style={{ margin: 0 }}>{t('sources.intro')}</p>
      <div className="list">
        {sources.length === 0 && <div className="list-row dim">{t('sources.none')}</div>}
        {sources.map((s) => {
          const sub = SUBSCRIPTION_KINDS.includes(s.kind);
          return (
            <div key={s.id} className="list-row wrap">
              <Icon name={sub ? 'user' : s.kind === 'local' ? 'server' : 'key'} />
              <div className="spacer">
                <div>{s.name}</div>
                <div className="faint" style={{ fontSize: 13 }}>
                  {t(`sources.kind.${s.kind}`)}{s.baseUrl ? ` · ${s.baseUrl}` : ''}
                  {sub && <> · <span className={`badge ${s.signedIn ? 'ok' : 'warn'}`}>{s.signedIn ? t('sources.signedIn') : t('sources.notSignedIn')}</span></>}
                </div>
                {sub && <p className="notice warn-box" style={{ margin: '6px 0 0' }}>{t('sources.personalUse')}</p>}
              </div>
              {s.kind === 'chatgpt-subscription' && <button className="btn" onClick={() => setLogin(s)}>{t('sources.signIn')}</button>}
              {s.kind === 'claude-subscription' && <button className="btn" onClick={() => setToken(s)}>{t('sources.setToken')}</button>}
              <button className="btn danger" onClick={async () => { await client!.call('DELETE', `/v1/sources/${s.id}`); await loadSources(); }}>{t('common.remove')}</button>
            </div>
          );
        })}
      </div>
      <div><button className="btn primary" onClick={() => setAdding(true)}><Icon name="plus" /> {t('sources.add')}</button></div>
      {adding && <AddSource onClose={async (s) => { setAdding(false); await loadSources(); if (s?.kind === 'chatgpt-subscription') setLogin(s); }} />}
      {login && <CodexLogin source={login} onClose={async () => { setLogin(null); await loadSources(); }} />}
      {token && <ClaudeToken source={token} onClose={async () => { setToken(null); await loadSources(); }} />}
    </div>
  );
}

function AddSource({ onClose }: { onClose(s?: ModelSource): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client } = useChat();
  const role = useStore((s) => s.user?.role);
  const kinds = KINDS.filter((k) => role === 'owner' || !OWNER_ONLY.includes(k));
  const [kind, setKind] = useState<ModelSourceKind>('anthropic');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const needsUrl = kind === 'local' || kind === 'openai-compatible';
  const needsKey = kind === 'anthropic' || kind === 'openai' || kind === 'openai-compatible';
  const keyOptional = kind === 'local';
  return (
    <Modal title={t('sources.add')} onClose={() => onClose()}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          const s = await client!.call<ModelSource>('POST', '/v1/sources', {
            kind, name: name.trim() || t(`sources.kind.${kind}`),
            ...(needsUrl ? { baseUrl: baseUrl.trim() } : {}),
            ...((needsKey || keyOptional) && apiKey ? { apiKey } : {}),
            ...(kind === 'claude-subscription' && token ? { token: token.trim() } : {}),
          });
          onClose(s);
        } catch (x) {
          setErr(toErr(x));
        }
      }}>
        <div className="field">
          <label className="label" htmlFor="src-kind">{t('sources.type')}</label>
          <select id="src-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as ModelSourceKind)}>
            {kinds.map((k) => <option key={k} value={k}>{t(`sources.kind.${k}`)}</option>)}
          </select>
          <p className="faint" style={{ fontSize: 13, margin: '6px 0 0' }}>{t(`sources.help.${kind}`)}</p>
        </div>
        {SUBSCRIPTION_KINDS.includes(kind) && <p className="notice warn-box">{t('sources.personalUse')}</p>}
        <div className="field">
          <label className="label" htmlFor="src-name">{t('sources.name')}</label>
          <input id="src-name" className="input" maxLength={64} value={name} placeholder={t(`sources.kind.${kind}`)} onChange={(e) => setName(e.target.value)} />
        </div>
        {needsUrl && (
          <div className="field">
            <label className="label" htmlFor="src-url">{t('sources.baseUrl')}</label>
            <input id="src-url" className="input" dir="ltr" required type="url" value={baseUrl} placeholder={kind === 'local' ? 'http://192.168.1.20:11434/v1' : 'https://api.example.com/v1'} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
        )}
        {(needsKey || keyOptional) && (
          <div className="field">
            <label className="label" htmlFor="src-key">{keyOptional ? t('sources.apiKeyOptional') : t('sources.apiKey')}</label>
            <input id="src-key" className="input" dir="ltr" type="password" autoComplete="off" required={needsKey} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
        )}
        {kind === 'claude-subscription' && (
          <div className="field">
            <label className="label" htmlFor="src-token">{t('sources.claudeToken')}</label>
            <input id="src-token" className="input" dir="ltr" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            <p className="faint" style={{ fontSize: 13, margin: '6px 0 0' }}>{t('sources.claudeTokenHelp')}</p>
          </div>
        )}
        {err && <div role="alert" className="error">{err}</div>}
        <div className="row"><span className="spacer" /><button type="button" className="btn" onClick={() => onClose()}>{t('common.cancel')}</button><button className="btn primary" type="submit">{t('common.add')}</button></div>
      </form>
    </Modal>
  );
}

function ClaudeToken({ source, onClose }: { source: ModelSource; onClose(): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client } = useChat();
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title={t('sources.setToken')} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await client!.call('PATCH', `/v1/sources/${source.id}`, { token: token.trim() });
          onClose();
        } catch (x) {
          setErr(toErr(x));
        }
      }}>
        <p className="dim" style={{ margin: 0 }}>{t('sources.claudeTokenHelp')}</p>
        <input className="input" dir="ltr" type="password" autoComplete="off" aria-label={t('sources.claudeToken')} required minLength={10} value={token} onChange={(e) => setToken(e.target.value)} />
        {err && <div role="alert" className="error">{err}</div>}
        <div className="row"><span className="spacer" /><button className="btn primary" type="submit">{t('common.save')}</button></div>
      </form>
    </Modal>
  );
}

function CodexLogin({ source, onClose }: { source: ModelSource; onClose(): void }) {
  const { t } = useTranslation();
  const { client } = useChat();
  const [s, setS] = useState<DeviceLogin | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const r = await client!.call<DeviceLogin>('GET', `/v1/sources/${source.id}/login`).catch(() => null);
      if (!live || !r) return;
      setS(r);
      if (r.state === 'waiting' || r.state === 'starting') timer = setTimeout(poll, 2000);
    };
    void client!.call<DeviceLogin>('POST', `/v1/sources/${source.id}/login`, {}).then((r) => {
      if (!live) return;
      setS(r);
      timer = setTimeout(poll, 2000);
    }, () => live && setS({ state: 'failed', url: null, code: null, error: 'login_failed' }));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, source.id]);
  return (
    <Modal title={t('sources.signInTitle')} onClose={() => { if (s?.state === 'waiting') void client!.call('DELETE', `/v1/sources/${source.id}/login`); onClose(); }}>
      <div className="stack">
        <p className="notice warn-box">{t('sources.personalUse')}</p>
        {(!s || s.state === 'starting') && <p className="dim">{t('sources.loginStarting')}</p>}
        {s?.state === 'waiting' && (
          <>
            <p style={{ margin: 0 }}>{t('sources.loginSteps')}</p>
            <button className="btn" onClick={() => platform().openExternal(s.url!)}><Icon name="link" /> <span dir="ltr">{s.url}</span></button>
            <div className="code-display" aria-label={t('sources.loginCode')}>{s.code}</div>
            <p className="dim" role="status">{t('sources.loginWaiting')}</p>
          </>
        )}
        {s?.state === 'done' && <p className="badge ok" role="status">{t('sources.signedIn')}</p>}
        {s?.state === 'failed' && <p className="error" role="alert">{t('sources.loginFailed')}</p>}
        <div className="row"><span className="spacer" /><button className="btn primary" onClick={onClose}>{s?.state === 'done' ? t('common.done') : t('common.close')}</button></div>
      </div>
    </Modal>
  );
}

export function BotsSection() {
  const { t } = useTranslation();
  const { bots, refresh } = useChat();
  const [edit, setEdit] = useState<Bot | 'new' | null>(null);
  useEffect(() => void refresh(), [refresh]);
  return (
    <div className="stack">
      <div className="list">
        {bots.map((b) => (
          <div key={b.id} className="list-row">
            <BotAvatar bot={b} />
            <div className="spacer"><div>{b.name} {b.primary && <span className="badge">{t('bot.primary')}</span>}</div><div className="faint" style={{ fontSize: 13 }}>{t(`bot.engines.${b.engine}`)}</div></div>
            <button className="btn" onClick={() => setEdit(b)}>{t('common.edit')}</button>
          </div>
        ))}
      </div>
      <div><button className="btn primary" onClick={() => setEdit('new')}><Icon name="plus" /> {t('nav.newBot')}</button></div>
      {edit && <BotEditor bot={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

export function NotificationsSection() {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client, refresh } = useChat();
  const role = useStore((s) => s.user?.role);
  const [n, setN] = useState<Notifications | null>(null);
  const [server, setServer] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await client!.call<Notifications>('GET', '/v1/notifications');
    setN(r);
    setServer(r.pushServer ?? '');
  }, [client]);
  useEffect(() => void load(), [load]);
  const patch = async (body: Record<string, unknown>) => {
    setErr(null);
    try {
      setN(await client!.call<Notifications>('PATCH', '/v1/notifications', body));
      await refresh();
    } catch (x) {
      setErr(toErr(x));
    }
  };
  const bridge = platform();
  if (!n) return <p className="dim">{t('common.loading')}</p>;
  return (
    <div className="stack">
      <label className="list-row card" style={{ cursor: 'pointer' }}>
        <Icon name="bell" />
        <span className="spacer"><span style={{ display: 'block' }}>{t('notify.all')}</span><span className="faint" style={{ fontSize: 13 }}>{t('notify.allHelp')}</span></span>
        <input type="checkbox" role="switch" className="switch" checked={!n.muted} onChange={(e) => void patch({ muted: !e.target.checked })} />
      </label>
      <p className="dim" style={{ margin: 0 }}>{t('notify.perBot')}</p>
      {bridge.platform === 'android' ? (
        <div className="card stack">
          <strong>{t('notify.thisDevice')}</strong>
          <p className="dim" style={{ margin: 0 }}>{n.registered ? t('notify.registered') : n.pushServer ? t('notify.notRegistered') : t('notify.noServer')}</p>
          {n.pushServer && bridge.registerPush && (
            <div><button className="btn" onClick={async () => {
              setErr(null);
              try {
                const endpoint = await bridge.registerPush!(n.pushServer!);
                if (endpoint) setN(await client!.call<Notifications>('PUT', '/v1/push', { endpoint }));
              } catch (x) {
                setErr(toErr(x));
              }
            }}>{t('notify.enableHere')}</button></div>
          )}
        </div>
      ) : (
        <p className="dim" style={{ margin: 0 }}>{t('notify.desktop')}</p>
      )}
      {role === 'owner' && (
        <form className="card stack" onSubmit={(e) => { e.preventDefault(); void patch({ pushServer: server.trim() || null }); }}>
          <label className="label" htmlFor="push-server">{t('notify.pushServer')}</label>
          <input id="push-server" className="input" dir="ltr" type="url" value={server} placeholder="https://ntfy.example.net" onChange={(e) => setServer(e.target.value)} />
          <p className="faint" style={{ fontSize: 13, margin: 0 }}>{t('notify.pushServerHelp')}</p>
          <div><button className="btn" type="submit">{t('common.save')}</button></div>
        </form>
      )}
      {err && <div role="alert" className="error">{err}</div>}
    </div>
  );
}

export function UsageSection() {
  const { t, i18n } = useTranslation();
  const { client, botById, sources, loadSources } = useChat();
  const [rows, setRows] = useState<UsageRow[]>([]);
  useEffect(() => {
    void loadSources();
    void client?.call<UsageRow[]>('GET', '/v1/usage').then(setRows, () => undefined);
  }, [client, loadSources]);
  const num = new Intl.NumberFormat(i18n.language);
  const usd = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
  if (!rows.length) return <p className="dim">{t('usage.none')}</p>;
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('usage.bot')}</th><th>{t('usage.source')}</th><th>{t('usage.model')}</th><th>{t('usage.input')}</th><th>{t('usage.output')}</th><th>{t('usage.cost')}</th><th>{t('usage.turns')}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.botId}-${r.sourceId}-${r.model}`}>
                <td>{botById(r.botId)?.name ?? t('bot.deleted')}</td>
                <td>{sources.find((s) => s.id === r.sourceId)?.name ?? t(`sources.kind.${r.sourceKind}`)}</td>
                <td dir="ltr">{r.model}</td>
                <td>{num.format(r.inputTokens)}</td>
                <td>{num.format(r.outputTokens)}</td>
                <td>{r.costUsd === null ? <span className="faint">{t('usage.notReported')}</span> : usd.format(r.costUsd)}</td>
                <td>{num.format(r.turns)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="faint" style={{ fontSize: 13, margin: 0 }}>{t('usage.note')}</p>
    </div>
  );
}
