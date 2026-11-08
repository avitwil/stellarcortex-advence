// Settings → Updates (D-24, FR-CLI-05) and Settings → Browser UI (FR-CLI-04, D-16).
// Server updates are the owner's: check the signed feed, install and restart; the server rolls
// back by itself when the new version fails its health check (NFR-REL-02). Android installs its
// own signed APK from the feed; desktop apps update themselves after the same signature check.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useChat } from '../state/chat';
import { useStore } from '../state/store';
import { platform } from '../platform';
import type { AppUpdate } from '../lib/app-update';
import { Icon } from '../ui/Icon';
import { useErr } from './chat/ChatSettings';
import { ago } from '../lib/time';

export interface ServerUpdateStatus {
  current: string;
  enabled: boolean;
  canApply: boolean;
  available: { version: string; notes: string } | null;
  checkedAt: number | null;
  error: string | null;
  staged: string | null;
  lastFailed: { version: string; from: string | null; at: string; reason: string } | null;
}

export function UpdatesSection() {
  const owner = useStore((s) => s.user?.role === 'owner');
  return (
    <div className="stack">
      <AppUpdates />
      {owner && <ServerUpdates />}
    </div>
  );
}

function AppUpdates() {
  const { t } = useTranslation();
  const toErr = useErr();
  const p = platform();
  const [version, setVersion] = useState<string | null>(null);
  const [found, setFound] = useState<AppUpdate | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => void p.appUpdate?.version().then(setVersion).catch(() => undefined), [p]);
  if (p.selfUpdating) return <p className="dim" style={{ margin: 0 }}>{t('updates.desktopAuto')}</p>;
  if (!p.appUpdate) return null;
  const run = async (f: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await f();
    } catch (x) {
      setErr(toErr(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack" aria-labelledby="app-upd-h">
      <div className="row">
        <Icon name="device" />
        <h4 id="app-upd-h" className="spacer" style={{ margin: 0 }}>{t('updates.thisApp')}</h4>
        {version && <span className="faint mono" dir="ltr">{version}</span>}
      </div>
      {found === null && <p className="dim" style={{ margin: 0 }} role="status">{t('updates.upToDate')}</p>}
      {found && (
        <div className="stack" role="status">
          <div>{t('updates.available', { version: found.version })}</div>
          {found.notes && <p className="dim" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{found.notes}</p>}
        </div>
      )}
      {err && <p className="error" role="alert" style={{ margin: 0 }}>{err}</p>}
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => void run(async () => setFound(await p.appUpdate!.check()))}>{t('updates.check')}</button>
        {found && <button className="btn primary" disabled={busy} onClick={() => void run(() => p.appUpdate!.install(found))}><Icon name="download" /> {t('updates.installApp')}</button>}
      </div>
    </section>
  );
}

function ServerUpdates() {
  const { t } = useTranslation();
  const toErr = useErr();
  const client = useChat((s) => s.client);
  const [st, setSt] = useState<ServerUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (client) setSt(await client.call<ServerUpdateStatus>('GET', '/v1/update'));
  }, [client]);
  useEffect(() => void load().catch(() => undefined), [load]);
  if (!st) return null;
  const act = async (f: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await f();
    } catch (x) {
      setErr(toErr(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card stack" aria-labelledby="srv-upd-h">
      <div className="row">
        <Icon name="server" />
        <h4 id="srv-upd-h" className="spacer" style={{ margin: 0 }}>{t('updates.server')}</h4>
        <span className="faint mono" dir="ltr">{st.current}</span>
      </div>
      {!st.enabled && <p className="dim" style={{ margin: 0 }}>{t('updates.notSetUp')}</p>}
      {st.enabled && (
        <div className="stack" role="status">
          {restarting ? (
            <div>{t('updates.restarting', { version: restarting })}</div>
          ) : st.available ? (
            <>
              <div>{t('updates.available', { version: st.available.version })}</div>
              {st.available.notes && <p className="dim" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{st.available.notes}</p>}
            </>
          ) : st.checkedAt && !st.error ? (
            <div className="dim">{t('updates.upToDate')}</div>
          ) : null}
          {st.checkedAt && <div className="faint">{t('updates.checked', { when: ago(t, st.checkedAt) })}</div>}
          {st.error && <p className="notice warn-box" style={{ margin: 0 }}>{t(`updates.errors.${st.error}`, { defaultValue: t('updates.errors.feed_unavailable') })}</p>}
          {st.lastFailed && <p className="notice warn-box" style={{ margin: 0 }}>{t('updates.rolledBack', { version: st.lastFailed.version, from: st.lastFailed.from ?? '' })}</p>}
          {st.available && !st.canApply && <p className="dim" style={{ margin: 0 }}>{t('updates.notInstalled')}</p>}
        </div>
      )}
      {err && <p className="error" role="alert" style={{ margin: 0 }}>{err}</p>}
      {st.enabled && (
        <div className="row">
          <button className="btn" disabled={busy || !!restarting} onClick={() => void act(async () => setSt(await client!.call<ServerUpdateStatus>('POST', '/v1/update/check')))}>{t('updates.check')}</button>
          {st.available && st.canApply && !restarting && (
            <button className="btn primary" disabled={busy} onClick={() => void act(async () => {
              const r = await client!.call<{ version: string }>('POST', '/v1/update/apply');
              setRestarting(r.version);
            })}><Icon name="download" /> {t('updates.installServer')}</button>
          )}
        </div>
      )}
    </section>
  );
}

export function BrowserUiSection() {
  const { t } = useTranslation();
  const toErr = useErr();
  const client = useChat((s) => s.client);
  const [on, setOn] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (client) void client.call<{ browserUi: boolean }>('GET', '/v1/settings').then((s) => setOn(s.browserUi)).catch(() => undefined);
  }, [client]);
  if (on === null) return <p className="dim">{t('common.loading')}</p>;
  return (
    <div className="stack">
      <label className="row">
        <input type="checkbox" role="switch" checked={on} onChange={async (e) => {
          setErr(null);
          try {
            const s = await client!.call<{ browserUi: boolean }>('PATCH', '/v1/settings', { browserUi: e.target.checked });
            setOn(s.browserUi);
          } catch (x) {
            setErr(toErr(x));
          }
        }} />
        <span className="spacer">{t('browserUi.toggle')}</span>
      </label>
      <p className="dim" style={{ margin: 0 }}>{t('browserUi.help')}</p>
      {err && <p className="error" role="alert" style={{ margin: 0 }}>{err}</p>}
    </div>
  );
}
