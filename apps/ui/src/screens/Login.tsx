// Sign in with Google (FR-GGL-02): desktop loopback + PKCE, Android Credential Manager,
// browser UI with paste fallback (DL-006, DL-007).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../state/store';
import { platform } from '../platform';
import { ApiError } from '../api/client';
import { Icon, Logo } from '../ui/Icon';

export function LoginScreen() {
  const { t } = useTranslation();
  const { client, setUser, info, showConnect } = useStore();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [paste, setPaste] = useState<{ state: string; verifier: string } | null>(null);
  const [pasted, setPasted] = useState('');

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 403) setErr(t('login.notAllowed'));
    else if (e instanceof ApiError && e.code === 'google_not_configured') setErr(t('login.notConfigured'));
    else setErr(t('login.failed'));
  };

  const signIn = async () => {
    if (!client) return;
    setBusy(true);
    setErr(null);
    try {
      const p = platform();
      if (p.platform === 'android') {
        const { clientId } = await client.raw<{ clientId: string }>('GET', '/v1/auth/google/client', undefined, { session: false });
        const r = await p.googleSignIn({ clientId });
        if (r === 'paste' || !r.idToken) throw new Error('no id token');
        setUser((await client.googleIdToken(r.idToken)).user);
      } else {
        const s = await client.googleStart();
        const r = await p.googleSignIn({ authUrl: s.url });
        if (r === 'paste') {
          setPaste({ state: s.state, verifier: s.verifier });
          return;
        }
        if (!r.code || r.state !== s.state) throw new Error('state mismatch');
        setUser((await client.googleFinish(r.code, s.state, s.verifier)).user);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const finishPaste = async () => {
    if (!client || !paste) return;
    try {
      const u = new URL(pasted.trim());
      const code = u.searchParams.get('code');
      if (!code || u.searchParams.get('state') !== paste.state) throw new Error('bad url');
      setUser((await client.googleFinish(code, paste.state, paste.verifier)).user);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <main className="center-screen">
      <div className="panel stack">
        <Logo size={48} />
        <h1>{t('login.title')}</h1>
        <p className="dim">{info?.name}</p>
        {!paste ? (
          <button className="btn primary block" onClick={() => void signIn()} disabled={busy}>
            <Icon name="user" /> {busy ? t('login.waiting') : t('login.google')}
          </button>
        ) : (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void finishPaste(); }}>
            <h2 style={{ fontSize: 17, margin: 0 }}>{t('login.pasteTitle')}</h2>
            <p className="dim" style={{ margin: 0 }}>{t('login.pasteHelp')}</p>
            <input className="input mono" dir="ltr" aria-label={t('login.pasteTitle')} placeholder={t('login.pastePlaceholder')} value={pasted} onChange={(e) => setPasted(e.target.value)} />
            <button className="btn primary" type="submit" disabled={!pasted}>{t('common.confirm')}</button>
          </form>
        )}
        {err && <div role="alert" className="error">{err}</div>}
        <button className="btn ghost" onClick={showConnect}><Icon name="server" /> {t('settings.sections.servers')}</button>
        <p className="notice"><Icon name="shield" size={16} /> {t('security.honest')}</p>
      </div>
    </main>
  );
}
