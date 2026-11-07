// Settings (FR-UI-07). Sections become functional phase by phase; each one is listed.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Device } from '@advence/protocol';
import { useStore } from '../state/store';
import { Icon, type IconName } from '../ui/Icon';
import { QrImage } from '../ui/Qr';
import { CopyField } from '../ui/CopyField';
import { ago } from '../lib/time';
import { extraSections } from './settings-registry';

export type SectionId =
  | 'account' | 'models' | 'google' | 'mcp' | 'skills' | 'memory' | 'bots' | 'computer' | 'devices' | 'users'
  | 'appearance' | 'language' | 'notifications' | 'usage' | 'browserUi' | 'updates' | 'servers';

const SECTIONS: { id: SectionId; icon: IconName; owner?: boolean }[] = [
  { id: 'account', icon: 'user' },
  { id: 'models', icon: 'key' },
  { id: 'google', icon: 'globe' },
  { id: 'mcp', icon: 'mcp' },
  { id: 'skills', icon: 'skill' },
  { id: 'memory', icon: 'library' },
  { id: 'bots', icon: 'bot' },
  { id: 'computer', icon: 'computer' },
  { id: 'devices', icon: 'device' },
  { id: 'users', icon: 'group', owner: true },
  { id: 'appearance', icon: 'sun' },
  { id: 'language', icon: 'globe' },
  { id: 'notifications', icon: 'bell' },
  { id: 'usage', icon: 'activity' },
  { id: 'browserUi', icon: 'globe', owner: true },
  { id: 'updates', icon: 'download' },
  { id: 'servers', icon: 'server' },
];

export function Settings({ onClose, initial }: { onClose(): void; initial?: SectionId }) {
  const { t } = useTranslation();
  const user = useStore((s) => s.user);
  const [sec, setSec] = useState<SectionId | null>(initial ?? null);
  const visible = SECTIONS.filter((s) => !s.owner || user?.role === 'owner');
  const current = sec ?? 'account';
  return (
    <div className={`settings ${sec ? 'section-open' : ''}`}>
      <nav className="settings-nav" aria-label={t('settings.title')}>
        <div className="row" style={{ marginBlockEnd: 8 }}>
          <button className="btn icon ghost" onClick={onClose} aria-label={t('common.close')}><Icon name="back" className="flip" /></button>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('settings.title')}</h2>
        </div>
        {visible.map((s) => (
          <button key={s.id} className={`nav-item ${current === s.id ? 'active' : ''}`} aria-current={current === s.id ? 'page' : undefined} onClick={() => setSec(s.id)}>
            <Icon name={s.icon} /> {t(`settings.sections.${s.id}`)}
          </button>
        ))}
      </nav>
      <section className="settings-body" aria-labelledby="settings-h">
        <div className="row only-narrow" style={{ marginBlockEnd: 8 }}>
          <button className="btn icon ghost" onClick={() => setSec(null)} aria-label={t('common.back')}><Icon name="back" className="flip" /></button>
        </div>
        <h3 id="settings-h">{t(`settings.sections.${current}`)}</h3>
        <SectionBody id={current} />
      </section>
    </div>
  );
}

function SectionBody({ id }: { id: SectionId }): ReactNode {
  const { t } = useTranslation();
  const Extra = extraSections[id];
  if (Extra) return <Extra />;
  switch (id) {
    case 'account':
      return <AccountSection />;
    case 'devices':
      return <DevicesSection />;
    case 'users':
      return <UsersSection />;
    case 'appearance':
      return <AppearanceSection />;
    case 'language':
      return <LanguageSection />;
    case 'servers':
      return <ServersSection />;
    default:
      return <p className="dim">{t('settings.comingInPhase')}</p>;
  }
}

function AccountSection() {
  const { t } = useTranslation();
  const { user, signOut } = useStore();
  if (!user) return null;
  return (
    <div className="stack">
      <div className="card row">
        <div className="avatar lg" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</div>
        <div>
          <div style={{ fontWeight: 600 }}>{user.name}</div>
          <div className="dim">{t('settings.signedInAs', { email: user.email })}</div>
          <span className="badge">{t(`settings.role.${user.role}`)}</span>
        </div>
      </div>
      <p className="notice"><Icon name="shield" size={16} /> {t('security.honest')}</p>
      <div><button className="btn danger" onClick={() => void signOut()}><Icon name="logout" className="flip" /> {t('settings.signOut')}</button></div>
    </div>
  );
}

interface Pending { pairingId: string; deviceName: string; platform: string; code: string }

function DevicesSection() {
  const { t } = useTranslation();
  const { client, user } = useStore();
  const [devices, setDevices] = useState<Device[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!client) return;
    setDevices((await client.call<{ devices: Device[] }>('GET', '/v1/devices')).devices);
    if (user?.role === 'owner') setPending((await client.call<{ pairings: Pending[] }>('GET', '/v1/pairings')).pairings);
  }, [client, user]);
  useEffect(() => {
    void load();
    const off = client?.socket?.onEvent((ev) => ev === 'pairing.pending' && void load());
    const iv = setInterval(() => void load(), 5000);
    return () => {
      off?.();
      clearInterval(iv);
    };
  }, [load, client]);

  return (
    <div className="stack">
      {user?.role === 'owner' && (
        <div className="card stack">
          {!link ? (
            <div><button className="btn primary" onClick={async () => setLink((await client!.call<{ link: string }>('POST', '/v1/pairing-tokens', {})).link)}><Icon name="plus" /> {t('settings.devices.addDevice')}</button></div>
          ) : (
            <>
              <p className="dim" style={{ margin: 0 }}>{t('settings.devices.addHelp')}</p>
              <QrImage text={link} label={t('settings.devices.addDevice')} />
              <CopyField value={link} label={t('connect.paste')} />
            </>
          )}
        </div>
      )}
      {pending.length > 0 && (
        <div className="list" aria-label={t('settings.devices.pending')}>
          {pending.map((p) => (
            <form key={p.pairingId} className="list-row wrap" onSubmit={async (e) => {
              e.preventDefault();
              setErr(null);
              try {
                await client!.call('POST', `/v1/pairings/${p.pairingId}/approve`, { code: codes[p.pairingId] ?? '' });
                setLink(null);
                await load();
              } catch {
                setErr(t('settings.devices.codeMismatch'));
              }
            }}>
              <Icon name="device" />
              <div className="spacer"><div>{p.deviceName}</div><span className="badge warn">{t('settings.devices.pending')}</span></div>
              <input className="input mono" style={{ width: 120 }} dir="ltr" inputMode="numeric" pattern="\d{6}" maxLength={6} aria-label={t('settings.devices.typeCode')} placeholder="000000"
                value={codes[p.pairingId] ?? ''} onChange={(e) => setCodes({ ...codes, [p.pairingId]: e.target.value.replace(/\D/g, '') })} />
              <button className="btn primary" type="submit">{t('settings.devices.approve')}</button>
              <button className="btn" type="button" onClick={async () => { await client!.call('POST', `/v1/pairings/${p.pairingId}/reject`, {}); await load(); }}>{t('settings.devices.reject')}</button>
            </form>
          ))}
        </div>
      )}
      {err && <div role="alert" className="error">{err}</div>}
      <div className="list">
        {devices.map((d) => (
          <div className="list-row" key={d.id}>
            <Icon name="device" />
            <div className="spacer">
              <div>{d.name} {d.current && <span className="badge ok">{t('settings.devices.thisDevice')}</span>} {d.status === 'revoked' && <span className="badge">{t('settings.devices.revoked')}</span>}</div>
              <div className="faint" style={{ fontSize: 13 }}>{d.platform} · {t('settings.devices.lastSeen', { when: ago(t, d.lastSeenAt) })}</div>
            </div>
            {d.status === 'active' && !d.current && (
              <button className="btn danger" onClick={async () => { await client!.call('DELETE', `/v1/devices/${d.id}`); await load(); }}>{t('settings.devices.revoke')}</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function UsersSection() {
  const { t } = useTranslation();
  const client = useStore((s) => s.client);
  const [entries, setEntries] = useState<{ id: string; email: string; role: string; bound: boolean }[]>([]);
  const [email, setEmail] = useState('');
  const load = useCallback(async () => setEntries((await client!.call<{ entries: typeof entries }>('GET', '/v1/allowlist')).entries), [client]);
  useEffect(() => void load(), [load]);
  return (
    <div className="stack">
      <form className="row" onSubmit={async (e) => { e.preventDefault(); await client!.call('POST', '/v1/allowlist', { email }); setEmail(''); await load(); }}>
        <input className="input" type="email" dir="ltr" aria-label={t('settings.users.email')} placeholder={t('settings.users.email')} value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn primary" type="submit" disabled={!email}><Icon name="plus" /> {t('settings.users.add')}</button>
      </form>
      <div className="list">
        {entries.map((u) => (
          <div className="list-row" key={u.id}>
            <Icon name="user" />
            <div className="spacer"><div dir="ltr" style={{ textAlign: 'start' }}>{u.email}</div><span className="badge">{t(`settings.role.${u.role}`)}</span> <span className="faint">{u.bound ? t('settings.users.bound') : t('settings.users.notYet')}</span></div>
            {u.role !== 'owner' && <button className="btn danger" onClick={async () => { await client!.call('DELETE', `/v1/allowlist/${u.id}`); await load(); }}>{t('common.remove')}</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { t } = useTranslation();
  const { theme, setTheme } = useStore();
  return (
    <div className="field">
      <span className="label" id="theme-l">{t('settings.theme.label')}</span>
      <div className="seg" role="group" aria-labelledby="theme-l">
        {(['light', 'dark', 'system'] as const).map((v) => (
          <button key={v} aria-pressed={theme === v} onClick={() => setTheme(v)}>{t(`settings.theme.${v}`)}</button>
        ))}
      </div>
    </div>
  );
}

function LanguageSection() {
  const { t } = useTranslation();
  const { lang, setLang } = useStore();
  return (
    <div className="field">
      <span className="label" id="lang-l">{t('settings.language.label')}</span>
      <div className="seg" role="group" aria-labelledby="lang-l">
        {(['he', 'en'] as const).map((v) => (
          <button key={v} lang={v} aria-pressed={lang === v} onClick={() => setLang(v)}>{t(`settings.language.${v}`)}</button>
        ))}
      </div>
    </div>
  );
}

function ServersSection() {
  const { t } = useTranslation();
  const { servers, active, switchServer, showConnect } = useStore();
  return (
    <div className="stack">
      <div className="list">
        {servers.map((s) => (
          <div className="list-row" key={s.id}>
            <Icon name="server" />
            <div className="spacer"><div>{s.name}</div><div className="faint mono" dir="ltr">{s.host}</div></div>
            {active?.id === s.id ? <span className="badge ok">{t('connect.active')}</span> : <button className="btn" onClick={() => void switchServer(s.id)}>{t('connect.switchTo')}</button>}
          </div>
        ))}
      </div>
      <div><button className="btn" onClick={showConnect}><Icon name="plus" /> {t('connect.addServer')}</button></div>
    </div>
  );
}
