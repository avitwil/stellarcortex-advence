// Activity log (P2 base): what Bots did, newest first.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActivityEntry } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { Icon } from '../../ui/Icon';
import type { ShellProps } from '../shell-registry';

export function ActivityView({ setView }: ShellProps) {
  const { t, i18n } = useTranslation();
  const { client, botById, conversations } = useChat();
  const [items, setItems] = useState<ActivityEntry[]>([]);
  useEffect(() => {
    void client?.call<ActivityEntry[]>('GET', '/v1/activity?limit=200').then(setItems, () => undefined);
  }, [client, conversations]);
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <>
      <header className="topbar">
        <button className="btn icon ghost only-narrow" aria-label={t('common.back')} onClick={() => setView({ kind: 'home' })}><Icon name="back" className="flip" /></button>
        <h2>{t('nav.activity')}</h2>
      </header>
      <div className="messages">
        <div className="messages-inner">
          {items.length === 0 && <div className="empty-state">{t('activity.empty')}</div>}
          {items.length > 0 && (
            <div className="list">
              {items.map((a) => (
                <div key={a.id} className="list-row">
                  <Icon name={a.kind.startsWith('reply.error') ? 'close' : a.kind === 'delegate' || a.kind === 'handoff' ? 'reply' : 'activity'} />
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
