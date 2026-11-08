// Chat-first home (FR-UI-01): Bots and group chats, a "+" menu and global search.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SearchResult } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { Icon } from '../../ui/Icon';
import type { ShellProps } from '../shell-registry';
import { BotAvatar } from './BotAvatar';
import { BotEditor } from './BotEditor';
import { NewGroup } from './NewGroup';
import { PauseAllButton } from './RoutinesView';

export function ChatSidebar({ view, setView }: ShellProps) {
  const { t } = useTranslation();
  const { bots, conversations, openDirect, client } = useChat();
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'bot' | 'group' | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim() || !client) {
      setResults(null);
      return;
    }
    const h = setTimeout(async () => setResults(await client.call<SearchResult>('GET', `/v1/search?q=${encodeURIComponent(q.trim())}`)), 200);
    return () => clearTimeout(h);
  }, [q, client]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const directOf = (botId: string) => conversations.find((c) => c.kind === 'direct' && c.botIds[0] === botId);
  const groups = conversations.filter((c) => c.kind === 'group');
  const activeId = view.kind === 'conv' ? view.id : null;
  const openBot = async (botId: string) => setView({ kind: 'conv', id: directOf(botId)?.id ?? (await openDirect(botId)) });
  const titleOf = (convId: string) => conversations.find((c) => c.id === convId)?.title ?? '';

  return (
    <div className="sidebar-scroll">
      <div className="sidebar-search row">
        <label className="search-box spacer">
          <Icon name="search" size={16} />
          <input type="search" aria-label={t('common.search')} placeholder={t('nav.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div style={{ position: 'relative' }} ref={menuRef}>
          <button className="btn icon" aria-haspopup="menu" aria-expanded={menu} aria-label={t('nav.newMenu')} onClick={() => setMenu(!menu)}><Icon name="plus" /></button>
          {menu && (
            <div className="menu" role="menu" style={{ insetInlineEnd: 0, top: 44 }}>
              <button role="menuitem" className="nav-item" onClick={() => { setMenu(false); setDialog('bot'); }}><Icon name="bot" /> {t('nav.newBot')}</button>
              <button role="menuitem" className="nav-item" onClick={() => { setMenu(false); setDialog('group'); }}><Icon name="group" /> {t('nav.newGroup')}</button>
            </div>
          )}
        </div>
      </div>

      {results ? (
        <div className="sidebar-section" aria-live="polite">
          {results.bots.length > 0 && <div className="sidebar-title">{t('nav.bots')}</div>}
          {results.bots.map((b) => (
            <button key={b.id} className="nav-item" onClick={() => { setQ(''); void openBot(b.id); }}><Icon name="bot" /> {b.name}</button>
          ))}
          {results.groups.length > 0 && <div className="sidebar-title">{t('nav.groups')}</div>}
          {results.groups.map((g) => (
            <button key={g.id} className="nav-item" onClick={() => { setQ(''); setView({ kind: 'conv', id: g.id }); }}><Icon name="group" /> {g.title}</button>
          ))}
          {results.messages.length > 0 && <div className="sidebar-title">{t('search.messages')}</div>}
          {results.messages.map((m) => (
            <button key={m.id} className="nav-item" onClick={() => { setQ(''); setView({ kind: 'conv', id: m.conversationId, focus: m.id }); }}>
              <span className="stack" style={{ gap: 0, minWidth: 0 }}>
                <span className="faint" style={{ fontSize: 12 }}>{titleOf(m.conversationId)}</span>
                <span className="ellipsis bidi">{m.snippet}</span>
              </span>
            </button>
          ))}
          {results.files.length > 0 && <div className="sidebar-title">{t('search.files')}</div>}
          {results.files.map((f) => (
            <button key={f.id} className="nav-item" onClick={() => { setQ(''); setView({ kind: 'library' }); }}><Icon name="file" /> <span className="ellipsis">{f.title}</span></button>
          ))}
          {results.routines.length > 0 && <div className="sidebar-title">{t('nav.routines')}</div>}
          {results.routines.map((r) => (
            <button key={r.id} className="nav-item" onClick={() => { setQ(''); setView({ kind: 'routines' }); }}><Icon name="routine" /> {r.title}</button>
          ))}
          {!results.bots.length && !results.groups.length && !results.messages.length && !results.files.length && !results.routines.length && (
            <p className="dim" style={{ padding: '0 8px' }}>{t('search.none')}</p>
          )}
        </div>
      ) : (
        <>
          <div className="sidebar-section">
            <button className={`nav-item ${view.kind === 'library' ? 'active' : ''}`} onClick={() => setView({ kind: 'library' })}><Icon name="library" /> {t('nav.library')}</button>
            <button className={`nav-item ${view.kind === 'routines' ? 'active' : ''}`} onClick={() => setView({ kind: 'routines' })}><Icon name="routine" /> {t('nav.routines')}</button>
            <button className={`nav-item ${view.kind === 'activity' ? 'active' : ''}`} onClick={() => setView({ kind: 'activity' })}><Icon name="activity" /> {t('nav.activity')}</button>
            {bots.some((b) => b.proactive) && <div style={{ padding: '4px 8px' }}><PauseAllButton compact /></div>}
          </div>
          <div className="sidebar-section">
            <div className="sidebar-title">{t('nav.bots')}</div>
            {bots.map((b) => {
              const conv = directOf(b.id);
              return (
                <button key={b.id} className={`nav-item conv-item ${conv && conv.id === activeId ? 'active' : ''}`} aria-current={conv && conv.id === activeId ? 'page' : undefined} onClick={() => void openBot(b.id)}>
                  <BotAvatar bot={b} />
                  <span className="conv-text">
                    <span className="conv-name">{b.name} {b.primary && <Icon name="star" size={12} className="faint" aria-label={t('bot.primary')} />}</span>
                    {conv?.lastPreview && <span className="conv-preview">{conv.lastPreview}</span>}
                  </span>
                  {conv && conv.unread > 0 && <span className="unread" aria-label={t('nav.unread', { n: conv.unread })}>{conv.unread}</span>}
                </button>
              );
            })}
          </div>
          <div className="sidebar-section">
            <div className="sidebar-title">{t('nav.groups')}</div>
            {groups.length === 0 && <p className="faint" style={{ padding: '0 8px', margin: 0, fontSize: 13 }}>{t('nav.noGroups')}</p>}
            {groups.map((g) => (
              <button key={g.id} className={`nav-item conv-item ${g.id === activeId ? 'active' : ''}`} aria-current={g.id === activeId ? 'page' : undefined} onClick={() => setView({ kind: 'conv', id: g.id })}>
                <span className="avatar group" aria-hidden="true"><Icon name="group" size={16} /></span>
                <span className="conv-text">
                  <span className="conv-name">{g.title}</span>
                  {g.lastPreview && <span className="conv-preview">{g.lastPreview}</span>}
                </span>
                {g.unread > 0 && <span className="unread" aria-label={t('nav.unread', { n: g.unread })}>{g.unread}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {dialog === 'bot' && <BotEditor onClose={(b) => { setDialog(null); if (b) void openBot(b.id); }} />}
      {dialog === 'group' && <NewGroup onClose={(id) => { setDialog(null); if (id) setView({ kind: 'conv', id }); }} />}
    </div>
  );
}
