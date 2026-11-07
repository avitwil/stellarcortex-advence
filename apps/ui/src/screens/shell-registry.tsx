// Shell content (P2): Bots and group chats in the sidebar; the main area shows a chat, the
// Library or the activity log.
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import type { View } from './Shell';
import type { SocketState } from '../api/socket';
import { ChatSidebar } from './chat/Sidebar';
import { ChatView } from './chat/ChatView';
import { LibraryView } from './chat/LibraryView';
import { ActivityView } from './chat/ActivityView';
import { Logo } from '../ui/Icon';

export interface ShellProps {
  view: View;
  setView(v: View): void;
  socketState?: SocketState;
}

function Home() {
  const { t } = useTranslation();
  return (
    <div className="empty-state stack" style={{ alignItems: 'center' }}>
      <Logo size={56} />
      <p>{t('chat.pickBot')}</p>
    </div>
  );
}

function Main(p: ShellProps) {
  switch (p.view.kind) {
    case 'conv':
      return p.view.id ? <ChatView key={p.view.id} {...p} /> : <Home />;
    case 'library':
      return <LibraryView {...p} />;
    case 'activity':
      return <ActivityView {...p} />;
    default:
      return <Home />;
  }
}

export const shellExtension: { Sidebar: ComponentType<ShellProps>; Main: ComponentType<ShellProps> } = { Sidebar: ChatSidebar, Main };
