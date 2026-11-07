// New group chat with several Bots (FR-BOT-03).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Conversation } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { Modal } from './Modal';
import { BotAvatar } from './BotAvatar';

export function NewGroup({ conv, onClose }: { conv?: Conversation; onClose(id?: string): void }) {
  const { t } = useTranslation();
  const { bots, client, refresh } = useChat();
  const [title, setTitle] = useState(conv?.title ?? '');
  const [ids, setIds] = useState<string[]>(conv?.botIds ?? []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const c = conv
        ? await client!.call<Conversation>('PATCH', `/v1/conversations/${conv.id}`, { title: title.trim(), botIds: ids })
        : await client!.call<Conversation>('POST', '/v1/conversations/group', { title: title.trim(), botIds: ids });
      await refresh();
      onClose(c.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={conv ? t('group.edit') : t('nav.newGroup')} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="field">
          <label className="label" htmlFor="group-title">{t('group.title')}</label>
          <input id="group-title" className="input" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">{t('group.members')}</legend>
          <div className="list">
            {bots.map((b) => (
              <label key={b.id} className="list-row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={ids.includes(b.id)} onChange={(e) => setIds(e.target.checked ? [...ids, b.id] : ids.filter((x) => x !== b.id))} />
                <BotAvatar bot={b} />
                <span className="spacer">{b.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>{t('group.mentionHelp')}</p>
        <div className="row">
          {conv && <button type="button" className="btn danger" onClick={async () => { await client!.call('DELETE', `/v1/conversations/${conv.id}`); await refresh(); onClose(); }}>{t('group.delete')}</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => onClose()}>{t('common.cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !title.trim() || ids.length === 0}>{conv ? t('common.save') : t('group.create')}</button>
        </div>
      </form>
    </Modal>
  );
}
