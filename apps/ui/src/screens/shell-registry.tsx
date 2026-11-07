// The P1 shell content: an empty home with a server round-trip check. P2 replaces these
// with Bots, group chats, Library, routines and search.
import { useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../state/store';
import { Icon } from '../ui/Icon';
import type { View } from './Shell';
import type { SocketState } from '../api/socket';

export interface ShellProps {
  view: View;
  setView(v: View): void;
  socketState?: SocketState;
}

function P1Sidebar(_: ShellProps) {
  const { t } = useTranslation();
  return (
    <div className="sidebar-scroll">
      <div className="sidebar-search">
        <label className="search-box"><Icon name="search" size={16} /><input aria-label={t('common.search')} placeholder={t('nav.searchPlaceholder')} /></label>
      </div>
    </div>
  );
}

function P1Main({ socketState }: ShellProps) {
  const { t } = useTranslation();
  const client = useStore((s) => s.client);
  const [text, setText] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  return (
    <>
      <div className="messages"><div className="messages-inner">
        <div className="empty-state">{reply ? t('chat.roundTrip', { text: reply }) : t('chat.empty')}</div>
      </div></div>
      <div className="composer-wrap">
        <form className="composer" onSubmit={async (e) => {
          e.preventDefault();
          const r = await client!.socket!.send<{ echo: string }>('chat.ping', { text });
          setReply(r.echo);
          setText('');
        }}>
          <textarea rows={1} value={text} aria-label={t('chat.placeholder', { name: 'StellarCortex' })} placeholder={t('chat.placeholder', { name: 'StellarCortex' })} onChange={(e) => setText(e.target.value)} />
          <button className="send-btn" type="submit" disabled={!text || socketState !== 'open'} aria-label={t('chat.send')}><Icon name="send" className="flip" /></button>
        </form>
      </div>
    </>
  );
}

export const shellExtension: { Sidebar: ComponentType<ShellProps>; Main: ComponentType<ShellProps> } = { Sidebar: P1Sidebar, Main: P1Main };
