// Pairing confirmation: shows the 6-digit code and waits for approval (NFR-SEC-02).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../state/store';
import { Logo } from '../ui/Icon';

export function PairingScreen() {
  const { t } = useTranslation();
  const { active, client, updateServer, resolvePhase, removeServer } = useStore();
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected' | 'expired' | 'error'>('pending');

  useEffect(() => {
    if (!active?.pairingId || !client) return;
    let stop = false;
    const poll = async () => {
      while (!stop) {
        try {
          const r = await client.pairingStatus(active.pairingId!);
          if (r.status !== 'pending') {
            setStatus(r.status);
            if (r.status === 'approved') {
              updateServer({ ...active, state: 'paired', pairingCode: undefined, pairingId: undefined });
              await resolvePhase();
            }
            return;
          }
        } catch (e) {
          setStatus((e as { code?: string }).code === 'device_revoked' ? 'rejected' : 'error');
          if ((e as { code?: string }).code === 'device_revoked') return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [active, client, updateServer, resolvePhase]);

  return (
    <main className="center-screen">
      <div className="panel stack">
        <Logo size={48} />
        <h1>{t('pairing.title')}</h1>
        <p className="dim">{t('pairing.codeIntro')}</p>
        <div className="code-display" aria-live="polite" aria-label={active?.pairingCode?.split('').join(' ')}>{active?.pairingCode}</div>
        <p role="status" className={status === 'rejected' || status === 'expired' || status === 'error' ? 'error' : 'dim'}>
          {status === 'pending' && t('pairing.waiting')}
          {status === 'approved' && t('pairing.approved')}
          {status === 'rejected' && t('pairing.rejected')}
          {status === 'expired' && t('pairing.expired')}
          {status === 'error' && t('pairing.failed')}
        </p>
        {(status === 'rejected' || status === 'expired') && active && (
          <button className="btn" onClick={() => void removeServer(active.id)}>{t('common.back')}</button>
        )}
      </div>
    </main>
  );
}
