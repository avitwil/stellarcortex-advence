// First-run setup wizard (FR-GGL-01): own free Google Cloud project, step by step.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../state/store';
import { platform } from '../platform';
import { Icon, Logo } from '../ui/Icon';
import { CopyField } from '../ui/CopyField';

interface SetupInfo {
  webRedirectUri: string;
  androidPackage: string;
  androidSha1: string;
  steps: { id: 'project' | 'apis' | 'consent' | 'audience' | 'webClient' | 'androidClient' | 'paste'; url?: string }[];
}

export function SetupScreen() {
  const { t } = useTranslation();
  const { client, resolvePhase } = useStore();
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [i, setI] = useState(0);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client?.raw<SetupInfo>('GET', '/v1/setup', undefined, { session: false }).then(setInfo).catch(() => setErr(t('common.error')));
  }, [client, t]);

  if (!info) return <main className="center-screen"><p className="dim">{err ?? t('common.loading')}</p></main>;
  const step = info.steps[i]!;
  const total = info.steps.length;

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await client!.raw('POST', '/v1/setup/google', { clientId: clientId.trim(), clientSecret: secret.trim() }, { session: false });
      await resolvePhase();
    } catch {
      setErr(t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="center-screen">
      <div className="panel stack">
        <Logo size={40} />
        <h1>{t('setup.title')}</h1>
        {i === 0 && <p className="dim">{t('setup.intro')}</p>}
        <div className="card stack">
          <div className="faint" aria-live="polite">{t('setup.stepOf', { n: i + 1, total })}</div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t(`setup.steps.${step.id}.title`)}</h2>
          <p className="dim" style={{ margin: 0 }}>{t(`setup.steps.${step.id}.body`)}</p>
          {step.id === 'webClient' && <CopyField value={info.webRedirectUri} label={t('setup.steps.webClient.title')} />}
          {step.id === 'androidClient' && (
            <>
              <div><span className="label">{t('setup.packageName')}</span><CopyField value={info.androidPackage} label={t('setup.packageName')} /></div>
              <div><span className="label">{t('setup.sha1')}</span><CopyField value={info.androidSha1} label={t('setup.sha1')} /></div>
            </>
          )}
          {step.url && (
            <button className="btn" onClick={() => platform().openExternal(step.url!)}>
              <Icon name="globe" /> {t('setup.openConsole')}
            </button>
          )}
          {step.id === 'paste' && (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
              <div>
                <label className="label" htmlFor="cid">{t('setup.clientId')}</label>
                <input id="cid" className="input mono" dir="ltr" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} />
              </div>
              <div>
                <label className="label" htmlFor="csec">{t('setup.clientSecret')}</label>
                <input id="csec" className="input mono" dir="ltr" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
              </div>
              {err && <div role="alert" className="error">{err}</div>}
              <button className="btn primary" type="submit" disabled={busy || !clientId || !secret}>{t('setup.saveAndContinue')}</button>
            </form>
          )}
        </div>
        <div className="row">
          <button className="btn" disabled={i === 0} onClick={() => setI(i - 1)}><Icon name="back" className="flip" /> {t('common.back')}</button>
          <span className="spacer" />
          {i < total - 1 && <button className="btn primary" onClick={() => setI(i + 1)}>{t('common.next')} <Icon name="chevron" className="flip" /></button>}
        </div>
      </div>
    </main>
  );
}
