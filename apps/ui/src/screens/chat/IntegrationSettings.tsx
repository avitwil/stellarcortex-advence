// Settings → Google (FR-GGL-04/05) and Settings → MCP (FR-MCP-03/04/05): the Google connection
// with its services and expiry; MCP servers with add, remove, per-Bot enable, tools and
// allowlists, sign-in; and, for the owner, this server's own MCP endpoint and access tokens.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpAccessToken, McpServer, McpServerSelf } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { useStore } from '../../state/store';
import { useIntegrations } from '../../state/integrations';
import { Icon } from '../../ui/Icon';
import { CopyField } from '../../ui/CopyField';
import { ago } from '../../lib/time';
import { useErr } from './ChatSettings';
import { PasteCard } from './Integrations';

export function GoogleSection() {
  const { t } = useTranslation();
  const toErr = useErr();
  const { google, loadGoogle, connectGoogle, disconnectGoogle } = useIntegrations();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void loadGoogle(), [loadGoogle]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(false);
    }
  };
  if (!google) return <p className="dim">{t('common.loading')}</p>;
  const badge = { none: '', ok: 'ok', expiring: 'warn', reconnect: 'warn' }[google.state];
  return (
    <div className="stack">
      <p className="dim" style={{ margin: 0 }}>{t('google.help')}</p>
      <div className="card stack">
        <div className="row wrap">
          <strong className="spacer">{google.email ?? t('google.notConnected')}</strong>
          <span className={`badge ${badge}`}>{t(`google.state.${google.state}`)}</span>
        </div>
        {google.state !== 'none' && (
          <>
            <div className="row wrap" aria-label={t('google.services')}>
              {(['gmail', 'calendar', 'drive', 'contacts'] as const).map((s) => (
                <span key={s} className={`badge ${google.services.includes(s) ? 'ok' : ''}`}>
                  {google.services.includes(s) ? '✓' : '✕'} {t(`google.service.${s}`)}
                </span>
              ))}
            </div>
            {google.missing.length > 0 && <p className="notice" style={{ margin: 0 }}>{t('google.missing')}</p>}
            {google.expiresAt && google.state !== 'reconnect' && <p className="faint" style={{ margin: 0, fontSize: 13 }}>{t('google.expiresIn', { days: Math.max(0, Math.ceil((google.expiresAt - Date.now()) / 86_400_000)) })}</p>}
          </>
        )}
        {err && <div role="alert" className="error">{err}</div>}
        <div className="row wrap">
          <button className="btn primary" disabled={busy} onClick={() => void run(connectGoogle)}>{google.state === 'none' ? t('google.connect') : t('google.reconnect')}</button>
          {google.state !== 'none' && <button className="btn danger" disabled={busy} onClick={() => void run(disconnectGoogle)}>{t('google.disconnect')}</button>}
        </div>
      </div>
      <p className="notice"><Icon name="shield" size={16} /> {t('google.testingNote')}</p>
      <PasteCard />
    </div>
  );
}

function parsePairs(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const i = line.search(/[=:]/);
    if (i <= 0) return null;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function AddServer({ onDone }: { onDone(): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client, bots } = useChat();
  const [transport, setTransport] = useState<'http' | 'stdio'>('http');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [secrets, setSecrets] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [botIds, setBotIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setErr(null);
    const pairs = parsePairs(secrets);
    if (!pairs) {
      setErr(t('mcp.add.badSecrets'));
      return;
    }
    const has = Object.keys(pairs).length > 0;
    const body = transport === 'http'
      ? { name, transport, url: target, bots: botIds, ...(has ? { headers: pairs } : {}), ...(clientId ? { oauthClient: { clientId, ...(clientSecret ? { clientSecret } : {}) } } : {}) }
      : { name, transport, command: target, bots: botIds, ...(has ? { env: pairs } : {}) };
    try {
      await client!.call('POST', '/v1/mcp/servers', body);
      onDone();
    } catch (e) {
      setErr(toErr(e));
    }
  };
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); void submit(); }} aria-label={t('mcp.add.title')}>
      <strong>{t('mcp.add.title')}</strong>
      <div className="row wrap" role="radiogroup" aria-label={t('mcp.add.transport')}>
        {(['http', 'stdio'] as const).map((k) => (
          <label key={k} className="row" style={{ gap: 4 }}>
            <input type="radio" name="mcp-transport" checked={transport === k} onChange={() => setTransport(k)} /> {t(`mcp.transport.${k}`)}
          </label>
        ))}
      </div>
      <label htmlFor="mcp-name">{t('mcp.add.name')}</label>
      <input id="mcp-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
      <label htmlFor="mcp-target">{transport === 'http' ? t('mcp.add.url') : t('mcp.add.command')}</label>
      <input id="mcp-target" className="input mono" dir="ltr" value={target} onChange={(e) => setTarget(e.target.value)} required placeholder={transport === 'http' ? 'https://mcp.example.com/mcp' : 'npx -y @modelcontextprotocol/server-everything'} />
      {transport === 'stdio' && <p className="notice" style={{ margin: 0 }}><Icon name="computer" size={16} /> {t('mcp.add.stdioNote')}</p>}
      <label htmlFor="mcp-secrets">{transport === 'http' ? t('mcp.add.headers') : t('mcp.add.env')}</label>
      <textarea id="mcp-secrets" className="input mono" dir="ltr" rows={2} value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder={transport === 'http' ? 'X-Api-Key=…' : 'API_KEY=…'} autoComplete="off" />
      {transport === 'http' && (
        <details>
          <summary>{t('mcp.add.preregistered')}</summary>
          <div className="stack">
            <input className="input mono" dir="ltr" aria-label={t('mcp.add.clientId')} placeholder={t('mcp.add.clientId')} value={clientId} onChange={(e) => setClientId(e.target.value)} />
            <input className="input mono" dir="ltr" type="password" aria-label={t('mcp.add.clientSecret')} placeholder={t('mcp.add.clientSecret')} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
          </div>
        </details>
      )}
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>{t('mcp.bots')}</legend>
        <div className="toggle-list">
          {bots.map((b) => (
            <label key={b.id} className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={botIds.includes(b.id)} onChange={(e) => setBotIds((x) => (e.target.checked ? [...x, b.id] : x.filter((y) => y !== b.id)))} /> {b.name}
            </label>
          ))}
        </div>
      </fieldset>
      {err && <div role="alert" className="error">{err}</div>}
      <div className="row">
        <button className="btn primary" type="submit">{t('mcp.add.save')}</button>
        <button className="btn ghost" type="button" onClick={onDone}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

function ServerCard({ s, reload }: { s: McpServer; reload(): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client, bots } = useChat();
  const authorize = useIntegrations((x) => x.authorize);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(toErr(e));
    } finally {
      setBusy(false);
    }
  };
  const patch = (b: Record<string, unknown>) => act(() => client!.call('PATCH', `/v1/mcp/servers/${s.id}`, b));
  const signIn = () => act(async () => {
    const { url } = await client!.call<{ url: string }>('POST', `/v1/mcp/servers/${s.id}/auth`, {});
    await authorize(url, s.name, async (callbackUrl) => {
      await client!.call('POST', `/v1/mcp/servers/${s.id}/auth/finish`, { callbackUrl });
      await client!.call('POST', `/v1/mcp/servers/${s.id}/check`, {});
      reload();
    });
  });
  const statusBadge = { ok: 'ok', error: 'warn', auth_required: 'warn', unknown: '' }[s.status];
  const allowed = (name: string) => s.allow === null || s.allow.includes(name);
  return (
    <section className="card stack" aria-label={s.name}>
      <div className="row wrap">
        <Icon name="mcp" />
        <strong className="spacer">{s.name}</strong>
        <span className="badge">{t(`mcp.transport.${s.transport}`)}</span>
        {s.era && <span className="badge">{s.era === 'modern' ? '2026-07-28' : '2025-11-25'}</span>}
        <span className={`badge ${statusBadge}`}>{t(`mcp.status.${s.status}`)}</span>
      </div>
      <span className="faint mono" dir="ltr" style={{ fontSize: 12, wordBreak: 'break-all' }}>{s.url ?? s.command}</span>
      {s.error && <p className="warn-box" style={{ margin: 0 }}>{s.error}</p>}
      {err && <div role="alert" className="error">{err}</div>}
      <div className="row wrap">
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={s.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} disabled={busy} /> {t('mcp.enabled')}
        </label>
        <span className="spacer" />
        <button className="btn" disabled={busy} onClick={() => void act(() => client!.call('POST', `/v1/mcp/servers/${s.id}/check`, {}))}><Icon name="refresh" /> {t('mcp.check')}</button>
        {s.transport === 'http' && (s.status === 'auth_required' || !s.signedIn) && <button className="btn primary" disabled={busy} onClick={() => void signIn()}>{t('mcp.signIn')}</button>}
        {s.signedIn && <button className="btn" disabled={busy} onClick={() => void act(() => client!.call('DELETE', `/v1/mcp/servers/${s.id}/auth`))}>{t('mcp.signOut')}</button>}
        <button className="btn ghost" aria-expanded={open} onClick={() => setOpen((x) => !x)}><Icon name="chevron" /> {t('mcp.details')}</button>
      </div>
      {open && (
        <div className="stack">
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{t('mcp.bots')}</legend>
            <div className="toggle-list">
              {bots.map((b) => (
                <label key={b.id} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={s.bots.includes(b.id)} disabled={busy} onChange={(e) => void patch({ bots: e.target.checked ? [...s.bots, b.id] : s.bots.filter((x) => x !== b.id) })} /> {b.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{t('mcp.tools', { n: s.tools.length })}</legend>
            {s.tools.length === 0 ? <p className="dim" style={{ margin: 0 }}>{t('mcp.noTools')}</p> : (
              <>
                <label className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={s.allow === null} disabled={busy} onChange={(e) => void patch({ allow: e.target.checked ? null : s.tools.map((x) => x.name) })} /> {t('mcp.allTools')}
                </label>
                <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {s.tools.map((tool) => (
                    <li key={tool.name} className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
                      <input type="checkbox" aria-label={tool.name} checked={allowed(tool.name)} disabled={busy || s.allow === null} onChange={(e) => void patch({ allow: e.target.checked ? [...(s.allow ?? []), tool.name] : (s.allow ?? []).filter((x) => x !== tool.name) })} />
                      <span className="stack" style={{ gap: 2 }}>
                        <span className="mono" dir="ltr">{tool.name}{tool.task ? ' ⏱' : ''}</span>
                        {tool.description && <span className="faint" style={{ fontSize: 12 }}>{tool.description}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {(s.resources > 0 || s.prompts > 0) && <p className="faint" style={{ margin: 0, fontSize: 13 }}>{t('mcp.extras', { resources: s.resources, prompts: s.prompts })}</p>}
          </fieldset>
          {(s.envNames.length > 0 || s.headerNames.length > 0) && <p className="faint mono" dir="ltr" style={{ margin: 0, fontSize: 12 }}>{[...s.envNames, ...s.headerNames].join(', ')} = ••••</p>}
          <button className="btn danger" disabled={busy} onClick={() => { if (confirm(t('mcp.removeConfirm', { name: s.name }))) void act(() => client!.call('DELETE', `/v1/mcp/servers/${s.id}`)); }}><Icon name="trash" /> {t('mcp.remove')}</button>
        </div>
      )}
    </section>
  );
}

function SelfServer() {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client } = useChat();
  const [self, setSelf] = useState<McpServerSelf | null>(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [cimd, setCimd] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const s = await client!.call<McpServerSelf>('GET', '/v1/mcp/self');
    setSelf(s);
    setCimd(s.clientMetadataUrl ?? '');
  }, [client]);
  useEffect(() => void load().catch(() => undefined), [load]);
  if (!self) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(toErr(e));
    }
  };
  const pem = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([self.certPem], { type: 'application/x-pem-file' }));
    a.download = 'advence-server.pem';
    a.click();
  };
  return (
    <section className="card stack" aria-label={t('mcp.self.title')}>
      <strong>{t('mcp.self.title')}</strong>
      <p className="dim" style={{ margin: 0 }}>{t('mcp.self.help')}</p>
      <CopyField value={self.endpoint} label={t('mcp.self.endpoint')} />
      <button className="btn" onClick={pem}><Icon name="download" /> {t('mcp.self.cert')}</button>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>{t('mcp.self.howto')}</p>
      <code className="mono" dir="ltr" style={{ fontSize: 12, wordBreak: 'break-all' }}>{`NODE_EXTRA_CA_CERTS=advence-server.pem claude mcp add --transport http advence ${self.endpoint} --header "Authorization: Bearer <token>"`}</code>
      <strong>{t('mcp.self.tokens')}</strong>
      {fresh && (
        <div className="warn-box stack">
          <span>{t('mcp.self.tokenOnce')}</span>
          <CopyField value={fresh} label={t('mcp.self.tokens')} />
        </div>
      )}
      <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {self.tokens.map((tk: McpAccessToken) => (
          <li key={tk.id} className="row">
            <span className="spacer">{tk.name}</span>
            <span className="faint" style={{ fontSize: 12 }}>{tk.lastUsed ? ago(t, tk.lastUsed) : t('mcp.self.neverUsed')}</span>
            <button className="btn icon ghost" aria-label={`${t('mcp.self.revoke')}: ${tk.name}`} onClick={() => void act(() => client!.call('DELETE', `/v1/mcp/tokens/${tk.id}`))}><Icon name="trash" /></button>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => { const r = await client!.call<{ token: string }>('POST', '/v1/mcp/tokens', { name }); setFresh(r.token); setName(''); }); }}>
        <input className="input" aria-label={t('mcp.self.tokenName')} placeholder={t('mcp.self.tokenName')} value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
        <button className="btn primary" type="submit"><Icon name="plus" /> {t('mcp.self.newToken')}</button>
      </form>
      <details>
        <summary>{t('mcp.self.cimd')}</summary>
        <p className="faint" style={{ fontSize: 13 }}>{t('mcp.self.cimdHelp')}</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => client!.call('PATCH', '/v1/mcp/settings', { clientMetadataUrl: cimd.trim() || null })); }}>
          <input className="input mono" dir="ltr" aria-label={t('mcp.self.cimd')} placeholder="https://example.com/advence/client-metadata.json" value={cimd} onChange={(e) => setCimd(e.target.value)} />
          <button className="btn" type="submit">{t('common.save')}</button>
        </form>
      </details>
      {err && <div role="alert" className="error">{err}</div>}
    </section>
  );
}

export function McpSection() {
  const { t } = useTranslation();
  const { client } = useChat();
  const role = useStore((s) => s.user?.role);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => setServers(await client!.call<McpServer[]>('GET', '/v1/mcp/servers')), [client]);
  useEffect(() => void load().catch(() => setServers([])), [load]);
  return (
    <div className="stack">
      <p className="dim" style={{ margin: 0 }}>{t('mcp.help')}</p>
      <PasteCard />
      {servers === null ? <p className="dim">{t('common.loading')}</p> : servers.length === 0 && !adding ? <p className="dim">{t('mcp.none')}</p> : null}
      {servers?.map((s) => <ServerCard key={s.id} s={s} reload={() => void load()} />)}
      {adding ? <AddServer onDone={() => { setAdding(false); void load(); }} /> : <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" /> {t('mcp.add.title')}</button>}
      {role !== 'owner' && <p className="notice"><Icon name="shield" size={16} /> {t('mcp.memberNote')}</p>}
      {role === 'owner' && <SelfServer />}
    </div>
  );
}
