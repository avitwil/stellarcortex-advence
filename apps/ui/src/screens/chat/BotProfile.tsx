// Bot profile (FR-UI-03): routines, notifications, Library, model and engine, computer status,
// "Proactive" and "Host control" toggles. Opened from the chat header on every client.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SUBSCRIPTION_KINDS, type Bot, type LibraryItem } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { Icon } from '../../ui/Icon';
import { Modal } from './Modal';
import { BotAvatar } from './BotAvatar';
import { BotEditor } from './BotEditor';
import { computerLabel } from './ComputerView';

export function BotProfile({ bot, onClose, onLibrary, onComputer }: { bot: Bot; onClose(): void; onLibrary(): void; onComputer(): void }) {
  const { t } = useTranslation();
  const { client, sources, loadSources, refresh, libraryTick, computers, loadComputer } = useChat();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [edit, setEdit] = useState(false);
  useEffect(() => void loadSources(), [loadSources]);
  useEffect(() => void loadComputer(bot.id), [bot.id, loadComputer]);
  useEffect(() => {
    void client?.call<LibraryItem[]>('GET', `/v1/library?botId=${bot.id}&limit=5`).then(setItems, () => undefined);
  }, [client, bot.id, libraryTick]);
  const source = sources.find((s) => s.id === bot.sourceId);
  const patch = async (body: Partial<Pick<Bot, 'proactive' | 'hostControl' | 'notify'>>) => {
    await client!.call('PATCH', `/v1/bots/${bot.id}`, body);
    await refresh();
  };
  if (edit) return <BotEditor bot={bot} onClose={() => setEdit(false)} />;
  return (
    <Modal title={t('bot.profile')} onClose={onClose}>
      <div className="stack">
        <div className="row">
          <BotAvatar bot={bot} size="lg" />
          <div className="spacer">
            <div style={{ fontWeight: 700, fontSize: 18 }}>{bot.name} {bot.primary && <span className="badge">{t('bot.primary')}</span>}</div>
            {bot.instructions && <div className="dim clamp-2">{bot.instructions}</div>}
          </div>
          <button className="btn" onClick={() => setEdit(true)}><Icon name="settings" size={16} /> {t('common.edit')}</button>
        </div>

        <div className="list">
          <div className="list-row">
            <Icon name="key" />
            <div className="spacer">
              <div>{t('bot.model')}</div>
              <div className="faint" style={{ fontSize: 13 }}>{source ? `${source.name} · ${bot.model || t('bot.modelDefault')}` : t('bot.noSource')}</div>
            </div>
          </div>
          {source && SUBSCRIPTION_KINDS.includes(source.kind) && <div className="list-row"><p className="notice warn-box" style={{ margin: 0 }}>{t('sources.personalUse')}</p></div>}
          <div className="list-row">
            <Icon name="code" />
            <div className="spacer"><div>{t('bot.engine')}</div><div className="faint" style={{ fontSize: 13 }}>{t(`bot.engines.${bot.engine}`)}</div></div>
          </div>
          <div className="list-row">
            <Icon name="computer" />
            <div className="spacer"><div>{t('bot.computer')}</div><div className="faint" style={{ fontSize: 13 }}>{computerLabel(t, computers[bot.id])}</div></div>
            <button className="btn small" onClick={onComputer}>{t('common.open')}</button>
          </div>
          <div className="list-row">
            <Icon name="routine" />
            <div className="spacer"><div>{t('nav.routines')}</div><div className="faint" style={{ fontSize: 13 }}>{t('bot.noRoutines')}</div></div>
          </div>
        </div>

        <div className="list">
          <Toggle icon="bell" label={t('bot.notifications')} help={t('bot.notificationsHelp')} on={bot.notify === 'all'} onChange={(v) => void patch({ notify: v ? 'all' : 'off' })} />
          <Toggle icon="sparkle" label={t('bot.proactive')} help={t('bot.proactiveHelp')} on={bot.proactive} onChange={(v) => void patch({ proactive: v })} />
          <Toggle icon="hand" label={t('bot.hostControl')} help={t('bot.hostControlHelp')} on={bot.hostControl} onChange={(v) => void patch({ hostControl: v })} />
        </div>

        <div>
          <div className="row" style={{ marginBlockEnd: 6 }}>
            <strong className="spacer">{t('nav.library')}</strong>
            <button className="btn ghost small" onClick={onLibrary}>{t('library.openAll')}</button>
          </div>
          {items.length === 0 ? <p className="dim" style={{ margin: 0 }}>{t('library.empty')}</p> : (
            <div className="list">
              {items.map((i) => <div key={i.id} className="list-row"><Icon name={i.kind === 'image' ? 'image' : i.kind === 'link' ? 'link' : 'file'} /><span className="ellipsis spacer">{i.title}</span></div>)}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Toggle({ icon, label, help, on, onChange }: { icon: 'bell' | 'sparkle' | 'hand'; label: string; help: string; on: boolean; onChange(v: boolean): void }) {
  return (
    <label className="list-row" style={{ cursor: 'pointer' }}>
      <Icon name={icon} />
      <span className="spacer"><span style={{ display: 'block' }}>{label}</span><span className="faint" style={{ fontSize: 13 }}>{help}</span></span>
      <input type="checkbox" role="switch" className="switch" checked={on} aria-checked={on} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
