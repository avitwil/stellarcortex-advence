import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from './state/store';
import { ConnectScreen } from './screens/Connect';
import { PairingScreen } from './screens/Pairing';
import { SetupScreen } from './screens/Setup';
import { LoginScreen } from './screens/Login';
import { Shell } from './screens/Shell';

export function App() {
  const { t } = useTranslation();
  const phase = useStore((s) => s.phase);
  const init = useStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);
  switch (phase) {
    case 'loading':
      return <main className="center-screen"><p className="dim" role="status">{t('common.loading')}</p></main>;
    case 'connect':
      return <ConnectScreen />;
    case 'pairing':
      return <PairingScreen />;
    case 'setup':
      return <SetupScreen />;
    case 'login':
      return <LoginScreen />;
    case 'ready':
      return <Shell />;
  }
}
