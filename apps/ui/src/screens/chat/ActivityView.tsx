// Activity log (P2 base): what Bots did, newest first.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActivityEntry } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { Icon } from '../../ui/Icon';
import type { ShellProps } from '../shell-registry';

export function ActivityView({ view, setView }: ShellProps) {
  const { t, i18n } = useTranslation();
  const { client, botById, conversations } = useChat();
  const [items, setItems] = useState<ActivityEntry[]>([]);
  // The global feed, or one Bot's when opened from its profile (FR-PRO-05).
  const botId = view.id;
  useEffect(() => {
    void client?.call<ActivityEntry[]>('GET', botId ? `/v1/bots/${botId}/activity?limit=200` : '/v1/activity?limit=200').then(setItems, () => undefined);
  }, [client, conversations, botId]);
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <>
      <header className="topbar">
        <button className="btn icon ghost only-narrow" aria-label={t('common.back')} onClick={() => setView({ kind: 'home' })}><Icon name="back" className="flip" /></button>
        <h2 className="spacer">{botId && botById(botId) ? `${t('nav.activity')} · ${botById(botId)!.name}` : t('nav.activity')}</h2>
        {botId && <button className="btn small ghost" onClick={() => setView({ kind: 'activity' })}>{t('bot.allBots')}</button>}
      </header>
      <div className="messages">
        <div className="messages-inner">
          {items.length === 0 && <div className="empty-state">{t('activity.empty')}</div>}
          {items.length > 0 && (
            <div className="list">
              {items.map((a) => (
                <div key={a.id} className="list-row">
                  <Icon name={a.kind.startsWith('reply.error') || a.kind === 'action.held' ? 'shield' : a.kind.startsWith('auto.') ? 'sparkle' : a.kind === 'delegate' || a.kind === 'handoff' ? 'reply' : 'activity'} />
                  <div className="spacer">
                    <div>{t(`activity.kinds.${a.kind}`, { ...a.params, defaultValue: a.kind })}</div>
                    <div className="faint" style={{ fontSize: 12 }}>{fmt.format(a.at)}{a.botId && botById(a.botId) ? ` · ${botById(a.botId)!.name}` : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
