// Library (FR-UI-04): what Bots produced (pages, images, videos, files, links), per Bot or
// for all Bots, grouped by date.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LibraryItem } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { Icon, type IconName } from '../../ui/Icon';
import { platform } from '../../platform';
import type { ShellProps } from '../shell-registry';

const KINDS = ['page', 'image', 'video', 'file', 'link'] as const;
const ICON: Record<LibraryItem['kind'], IconName> = { page: 'file', image: 'image', video: 'play', file: 'file', link: 'link' };

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function LibraryView({ view, setView }: ShellProps) {
  const { t, i18n } = useTranslation();
  const { client, bots, libraryTick, botById } = useChat();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [kind, setKind] = useState<LibraryItem['kind'] | 'all'>('all');
  const botId = view.id;
  useEffect(() => {
    void client?.call<LibraryItem[]>('GET', `/v1/library?limit=500${botId ? `&botId=${botId}` : ''}`).then(setItems, () => undefined);
  }, [client, botId, libraryTick]);
  const groups = useMemo(() => {
    const out = new Map<string, LibraryItem[]>();
    for (const i of items.filter((x) => kind === 'all' || x.kind === kind)) {
      const k = dayKey(i.createdAt);
      out.set(k, [...(out.get(k) ?? []), i]);
    }
    return [...out];
  }, [items, kind]);
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'full' });
  return (
    <>
      <header className="topbar">
        <button className="btn icon ghost only-narrow" aria-label={t('common.back')} onClick={() => setView({ kind: 'home' })}><Icon name="back" className="flip" /></button>
        <h2 className="spacer">{t('nav.library')}</h2>
        <select className="input" style={{ width: 'auto' }} aria-label={t('library.bot')} value={botId ?? ''} onChange={(e) => setView({ kind: 'library', id: e.target.value || undefined })}>
          <option value="">{t('library.allBots')}</option>
          {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </header>
      <div className="messages">
        <div className="messages-inner">
          <div className="seg" role="group" aria-label={t('library.kind')}>
            <button aria-pressed={kind === 'all'} onClick={() => setKind('all')}>{t('library.all')}</button>
            {KINDS.map((k) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{t(`library.kinds.${k}`)}</button>)}
          </div>
          {groups.length === 0 && <div className="empty-state">{t('library.empty')}</div>}
          {groups.map(([day, list]) => (
            <section key={day} aria-label={fmt.format(list[0]!.createdAt)}>
              <h3 className="sidebar-title" style={{ padding: '0 0 6px' }}>{fmt.format(list[0]!.createdAt)}</h3>
              <div className="list">
                {list.map((i) => (
                  <div key={i.id} className="list-row">
                    <Icon name={ICON[i.kind]} />
                    <div className="spacer" style={{ minWidth: 0 }}>
                      <div className="ellipsis">{i.title}</div>
                      <div className="faint" style={{ fontSize: 12 }}>{botById(i.botId)?.name ?? ''}{i.url ? ` · ${safeHost(i.url)}` : ''}</div>
                    </div>
                    {i.url && <button className="btn ghost small" onClick={() => platform().openExternal(i.url!)}>{t('common.open')}</button>}
                    {i.conversationId && <button className="btn ghost small" onClick={() => setView({ kind: 'conv', id: i.conversationId!, focus: i.messageId ?? undefined })}>{t('library.showInChat')}</button>}
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
