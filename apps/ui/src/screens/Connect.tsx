// Server-connection screen (FR-CLI-03): scan QR or paste a pairing link; saved servers.
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../state/store';
import { platform } from '../platform';
import { Icon, Logo } from '../ui/Icon';
import { QrScanner } from '../ui/Qr';
import { parseLink } from '../api/servers';

export function ConnectScreen() {
  const { t } = useTranslation();
  const { addFromLink, servers, active, switchServer, removeServer, error } = useStore();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(error === 'revoked' ? t('settings.devices.revoked') : null);
  const [scanning, setScanning] = useState(false);

  const submit = useCallback(
    async (text: string) => {
      if (!parseLink(text)) return setErr(t('connect.invalidLink'));
      setBusy(true);
      setErr(null);
      try {
        await addFromLink(text);
      } catch (e) {
        const m = String((e as Error).message);
        setErr(m.includes('pin_mismatch') ? t('pairing.pinMismatch') : t('pairing.failed'));
      } finally {
        setBusy(false);
      }
    },
    [addFromLink, t],
  );

  return (
    <main className="center-screen">
      <div className="panel stack">
        <Logo size={48} />
        <div>
          <h1>{t('connect.title')}</h1>
          <p className="dim">{t('connect.subtitle')}</p>
        </div>
        {platform().canScanQr && (
          <div className="stack">
            {scanning ? (
              <>
                <QrScanner onResult={(txt) => { setScanning(false); setLink(txt); void submit(txt); }} onError={(e) => { setScanning(false); setErr(e); }} />
                <button className="btn" onClick={() => setScanning(false)}>{t('connect.stopScan')}</button>
              </>
            ) : (
              <button className="btn primary block" onClick={() => setScanning(true)}>
                <Icon name="qr" /> {t('connect.scan')}
              </button>
            )}
          </div>
        )}
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(link); }}>
          <div>
            <label className="label" htmlFor="pair-link">{t('connect.paste')}</label>
            <input id="pair-link" className="input mono" dir="ltr" value={link} placeholder={t('connect.pastePlaceholder')} onChange={(e) => setLink(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <button className="btn primary block" type="submit" disabled={busy || !link.trim()}>
            <Icon name="link" /> {busy ? t('common.loading') : t('connect.connect')}
          </button>
          {err && <div role="alert" className="error">{err}</div>}
          <p className="faint" style={{ fontSize: 13 }}>{t('connect.howToGetLink')}</p>
        </form>
        {servers.length > 0 && (
          <section aria-labelledby="saved-h">
            <h2 id="saved-h" className="sidebar-title">{t('connect.saved')}</h2>
            <div className="list">
              {servers.map((s) => (
                <div className="list-row" key={s.id}>
                  <Icon name="server" />
                  <div className="spacer">
                    <div>{s.name}</div>
                    <div className="faint mono" dir="ltr">{s.host}</div>
                  </div>
                  {active?.id === s.id ? <span className="badge ok">{t('connect.active')}</span> : <button className="btn" onClick={() => void switchServer(s.id)}>{t('connect.switchTo')}</button>}
                  <button className="btn icon ghost" aria-label={t('connect.removeServer')} onClick={() => void removeServer(s.id)}><Icon name="trash" /></button>
                </div>
              ))}
            </div>
          </section>
        )}
        <p className="notice"><Icon name="shield" size={16} /> {t('security.honest')}</p>
      </div>
    </main>
  );
}
