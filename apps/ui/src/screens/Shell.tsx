// Chat-first home (FR-UI-01): sidebar with Bots and group chats, "+" menu, global search;
// main area shows the selected conversation. On narrow screens the sidebar becomes a
// list with stack navigation (FR-UI-08).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../state/store';
import { Icon, Logo } from '../ui/Icon';
import { Settings, type SectionId } from './Settings';
import type { SocketState } from '../api/socket';
import { shellExtension } from './shell-registry';
import { useChat } from '../state/chat';
import { useIntegrations } from '../state/integrations';
import { IntegrationTray } from './chat/Integrations';

export interface View { kind: 'home' | 'settings' | 'conv' | 'library' | 'activity'; id?: string; section?: SectionId; focus?: string }

export function Shell() {
  const { t } = useTranslation();
  const { client, user } = useStore();
  const [view, setView] = useState<View>({ kind: 'home' });
  const [sock, setSock] = useState<SocketState>('connecting');
  useEffect(() => useChat.getState().attach(client), [client]);
  useEffect(() => useIntegrations.getState().attach(client), [client]);
  useEffect(() => {
    if (!client) return;
    const s = client.openSocket();
    const off = s.onState(setSock);
    const offEv = s.onEvent((ev) => {
      if (ev === 'device.revoked' || ev === 'session.ended') void useStore.getState().resolvePhase();
    });
    return () => {
      off();
      offEv();
    };
  }, [client]);

  if (view.kind === 'settings') return <Settings onClose={() => setView({ kind: 'home' })} initial={(view as { section?: SectionId }).section} />;
  const Ext = shellExtension.Sidebar;
  const Main = shellExtension.Main;
  const mainOpen = view.kind !== 'home';
  return (
    <div className={`shell ${mainOpen ? 'chat-open' : ''}`}>
      <aside className="sidebar" aria-label={t('nav.home')}>
        <div className="sidebar-head">
          <Logo size={28} />
          <span className="brand">{t('app.name')}</span>
          <span className="spacer" />
          <span className={`status-dot ${sock === 'open' ? 'open' : sock === 'reconnecting' ? 'reconnecting' : ''}`} role="img" aria-label={sock === 'open' ? t('chat.connected') : sock === 'reconnecting' ? t('chat.reconnecting') : t('chat.offline')} />
        </div>
        <Ext view={view} setView={setView} />
        <div className="sidebar-foot">
          <button className="nav-item" aria-label={`${t('nav.settings')}: ${user?.name ?? ''}`} onClick={() => setView({ kind: 'settings' })}>
            <span className="avatar" aria-hidden="true">{user?.name.slice(0, 1).toUpperCase()}</span>
            <span>{user?.name}</span>
            <Icon name="settings" className="meta" />
          </button>
        </div>
      </aside>
      <main className="main">
        <Main view={view} setView={setView} socketState={sock} />
      </main>
      <IntegrationTray openSettings={(section) => setView({ kind: 'settings', section })} />
    </div>
  );
}
