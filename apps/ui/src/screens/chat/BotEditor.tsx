// Create and edit a Bot (FR-BOT-01): name, avatar, instructions, model source, model, engine, tools.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BOT_TOOLS, SUBSCRIPTION_KINDS, type Bot, type Engine } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { ApiError } from '../../api/client';
import { Modal } from './Modal';

const ENGINES: Engine[] = ['claude-agent-sdk', 'codex', 'opencode'];

export function BotEditor({ bot, onClose }: { bot?: Bot; onClose(saved?: Bot): void }) {
  const { t } = useTranslation();
  const { client, sources, loadSources, refresh } = useChat();
  const [name, setName] = useState(bot?.name ?? '');
  const [avatar, setAvatar] = useState(bot?.avatar ?? '');
  const [instructions, setInstructions] = useState(bot?.instructions ?? '');
  const [sourceId, setSourceId] = useState<string>(bot?.sourceId ?? '');
  const [model, setModel] = useState(bot?.model ?? '');
  const [engine, setEngine] = useState<Engine>(bot?.engine ?? 'claude-agent-sdk');
  const [tools, setTools] = useState<string[]>(bot?.tools ?? []);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => void loadSources(), [loadSources]);
  useEffect(() => {
    setModels([]);
    if (!sourceId || !client) return;
    let live = true;
    client.call<{ models: string[] }>('GET', `/v1/sources/${sourceId}/models`).then((r) => live && setModels(r.models), () => undefined);
    return () => {
      live = false;
    };
  }, [sourceId, client]);

  const source = sources.find((s) => s.id === sourceId);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const body = { name: name.trim(), avatar: avatar.trim() || undefined, instructions, sourceId: sourceId || null, model, engine, tools };
      const saved = bot ? await client!.call<Bot>('PATCH', `/v1/bots/${bot.id}`, body) : await client!.call<Bot>('POST', '/v1/bots', body);
      await refresh();
      onClose(saved);
    } catch (e) {
      setErr(e instanceof ApiError ? t(`errors.${e.code}`, { defaultValue: t('common.error') }) : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={bot ? t('bot.edit') : t('nav.newBot')} onClose={() => onClose()} wide>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="row">
          <div className="field" style={{ width: 90 }}>
            <label className="label" htmlFor="bot-avatar">{t('bot.avatar')}</label>
            <input id="bot-avatar" className="input" maxLength={8} value={avatar} placeholder={name.slice(0, 1).toUpperCase()} onChange={(e) => setAvatar(e.target.value)} />
          </div>
          <div className="field spacer">
            <label className="label" htmlFor="bot-name">{t('bot.name')}</label>
            <input id="bot-name" className="input" required maxLength={48} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="bot-instr">{t('bot.instructions')}</label>
          <textarea id="bot-instr" className="input" rows={5} maxLength={20000} value={instructions} placeholder={t('bot.instructionsHelp')} onChange={(e) => setInstructions(e.target.value)} />
        </div>
        <div className="row wrap">
          <div className="field spacer">
            <label className="label" htmlFor="bot-source">{t('bot.source')}</label>
            <select id="bot-source" className="input" value={sourceId} onChange={(e) => { setSourceId(e.target.value); setModel(''); }}>
              <option value="">{t('bot.noSource')}</option>
              {sources.map((s) => <option key={s.id} value={s.id}>{s.name} ({t(`sources.kind.${s.kind}`)})</option>)}
            </select>
          </div>
          <div className="field spacer">
            <label className="label" htmlFor="bot-model">{t('bot.model')}</label>
            <input id="bot-model" className="input" list="bot-models" dir="ltr" maxLength={200} value={model} placeholder={t('bot.modelDefault')} onChange={(e) => setModel(e.target.value)} />
            <datalist id="bot-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
          </div>
        </div>
        {source && SUBSCRIPTION_KINDS.includes(source.kind) && <p className="notice warn-box">{t('sources.personalUse')}</p>}
        {sources.length === 0 && <p className="dim" style={{ margin: 0 }}>{t('bot.addSourceFirst')}</p>}
        <div className="field">
          <label className="label" htmlFor="bot-engine">{t('bot.engine')}</label>
          <select id="bot-engine" className="input" value={engine} onChange={(e) => setEngine(e.target.value as Engine)}>
            {ENGINES.map((e) => <option key={e} value={e}>{t(`bot.engines.${e}`)}</option>)}
          </select>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">{t('bot.tools')}</legend>
          {BOT_TOOLS.map((tool) => (
            <label key={tool} className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={tools.includes(tool)} onChange={(e) => setTools(e.target.checked ? [...tools, tool] : tools.filter((x) => x !== tool))} />
              <span>{t(`bot.toolNames.${tool}`)}</span>
            </label>
          ))}
        </fieldset>
        {err && <div role="alert" className="error">{err}</div>}
        <div className="row">
          {bot && !bot.primary && (
            confirmDelete ? (
              <button type="button" className="btn danger" onClick={async () => { await client!.call('DELETE', `/v1/bots/${bot.id}`); await refresh(); onClose(); }}>{t('bot.confirmDelete')}</button>
            ) : (
              <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>{t('common.delete')}</button>
            )
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => onClose()}>{t('common.cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}
