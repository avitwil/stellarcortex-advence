// Routines tab (FR-UI-06): every routine with its trigger, next run and last result; pause and
// resume, run now, delete, and the run history with a link to each run's output in chat.
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { TRIGGER_KINDS, type Routine, type RoutineRun, type Trigger, type TriggerKind } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { useProactive } from '../../state/proactive';
import { Icon } from '../../ui/Icon';
import { CopyField } from '../../ui/CopyField';
import type { ShellProps } from '../shell-registry';
import { Modal } from './Modal';
import { useErr } from './ChatSettings';

const localTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function triggerText(t: TFunction, tr: Trigger): string {
  switch (tr.kind) {
    case 'schedule': return t('routines.triggers.scheduleText', { cron: tr.cron, tz: tr.tz });
    case 'mail': return tr.filter ? t('routines.triggers.mailText', { filter: tr.filter }) : t('routines.triggers.mailAny');
    case 'calendar': return t('routines.triggers.calendarText', { n: tr.leadMinutes });
    case 'watch': return t(tr.source === 'drive' ? 'routines.triggers.driveText' : 'routines.triggers.computerText', { path: tr.path || '…' });
    case 'webhook': return t('routines.triggers.webhookText');
    case 'mcp': return t('routines.triggers.mcpText', { uri: tr.uri });
    case 'digest': return t('routines.triggers.digestText', { time: tr.time, tz: tr.tz });
  }
}

function RunRow({ run, open }: { run: RoutineRun; open(convId: string, messageId?: string): void }) {
  const { t, i18n } = useTranslation();
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="list-row" data-testid={`run-${run.id}`}>
      <span className={`badge ${run.status === 'error' ? 'warn' : run.status === 'done' ? 'ok' : ''}`}>{t(`routines.status.${run.status}`)}</span>
      <div className="spacer" style={{ minWidth: 0 }}>
        <div className="ellipsis bidi">{run.trigger}</div>
        <div className="faint" style={{ fontSize: 12 }}>
          {fmt.format(run.startedAt)}
          {run.error ? ` · ${t(`routines.errors.${run.error}`, { defaultValue: run.error })}` : ''}
        </div>
      </div>
      {run.convId && <button className="btn small" onClick={() => open(run.convId!, run.messageId ?? undefined)}>{t('routines.output')}</button>}
    </div>
  );
}

function RoutineCard({ r, open }: { r: Routine; open(convId: string, messageId?: string): void }) {
  const { t, i18n } = useTranslation();
  const toErr = useErr();
  const bot = useChat((s) => s.botById(r.botId));
  const { runs, patch, remove, runNow, loadRuns, freshHook } = useProactive();
  const [history, setHistory] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(toErr(e));
    }
  };
  useEffect(() => {
    if (history) void loadRuns(r.id).catch(() => undefined);
  }, [history, r.id, loadRuns]);
  const list = runs[r.id] ?? [];
  const hook = freshHook?.id === r.id ? freshHook.url : null;
  return (
    <section className="card stack" aria-label={r.name}>
      <div className="row wrap">
        <Icon name="routine" />
        <strong className="spacer bidi">{r.name}</strong>
        {bot && <span className="badge">{bot.name}</span>}
        {r.paused && <span className="badge">{t('routines.paused')}</span>}
      </div>
      <div className="dim bidi">{triggerText(t, r.trigger)}</div>
      <div className="faint" style={{ fontSize: 13 }}>
        {r.paused ? t('routines.notScheduled') : r.nextRun ? t('routines.next', { when: fmt.format(r.nextRun) }) : t('routines.onTrigger')}
        {r.lastRun ? ` · ${t('routines.last', { when: fmt.format(r.lastRun.at), status: t(`routines.status.${r.lastRun.status}`) })}` : ''}
      </div>
      {bot && !bot.proactive && <p className="notice warn-box" style={{ margin: 0 }}>{t('routines.notProactive')}</p>}
      {hook && (
        <div className="stack" style={{ gap: 4 }}>
          <span className="label">{t('routines.webhookOnce')}</span>
          <CopyField value={hook} label={t('routines.webhookOnce')} />
        </div>
      )}
      {err && <div role="alert" className="error">{err}</div>}
      <div className="row wrap">
        <button className="btn small" onClick={() => void act(() => runNow(r.id))}><Icon name="play" size={14} /> {t('routines.runNow')}</button>
        <button className="btn small" onClick={() => void act(() => patch(r.id, { paused: !r.paused }))}>
          <Icon name={r.paused ? 'play' : 'pause'} size={14} /> {r.paused ? t('routines.resume') : t('routines.pause')}
        </button>
        <button className="btn small ghost" aria-expanded={history} onClick={() => setHistory(!history)}><Icon name="activity" size={14} /> {t('routines.history')}</button>
        <span className="spacer" />
        {confirm ? (
          <>
            <button className="btn small danger" onClick={() => void act(() => remove(r.id))}>{t('routines.confirmDelete')}</button>
            <button className="btn small ghost" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
          </>
        ) : (
          <button className="btn small ghost" aria-label={`${t('common.delete')}: ${r.name}`} onClick={() => setConfirm(true)}><Icon name="trash" size={14} /></button>
        )}
      </div>
      {history && (
        list.length === 0 ? <p className="dim" style={{ margin: 0 }}>{t('routines.noRuns')}</p> : <div className="list">{list.map((x) => <RunRow key={x.id} run={x} open={open} />)}</div>
      )}
    </section>
  );
}

function NewRoutine({ onClose, botId }: { onClose(): void; botId?: string }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const { bots, client } = useChat();
  const create = useProactive((s) => s.create);
  const [bot, setBot] = useState(botId ?? bots.find((b) => b.proactive)?.id ?? bots[0]?.id ?? '');
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [kind, setKind] = useState<TriggerKind>('schedule');
  const [cron, setCron] = useState('0 8 * * *');
  const [tz, setTz] = useState(localTz);
  const [filter, setFilter] = useState('');
  const [lead, setLead] = useState(15);
  const [source, setSource] = useState<'drive' | 'computer'>('drive');
  const [path, setPath] = useState('');
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [serverId, setServerId] = useState('');
  const [uri, setUri] = useState('');
  const [time, setTime] = useState('20:00');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind !== 'mcp' || !client) return;
    void client.call<{ id: string; name: string }[]>('GET', '/v1/mcp/servers').then((s) => {
      setServers(s);
      setServerId((v) => v || s[0]?.id || '');
    }, () => undefined);
  }, [kind, client]);
  const trigger = (): Trigger => {
    switch (kind) {
      case 'schedule': return { kind, cron: cron.trim(), tz };
      case 'mail': return { kind, filter: filter.trim() };
      case 'calendar': return { kind, leadMinutes: lead };
      case 'watch': return { kind, source, path: path.trim() };
      case 'webhook': return { kind };
      case 'mcp': return { kind, serverId, uri: uri.trim() };
      case 'digest': return { kind, time, tz };
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await create({ botId: bot, name: name.trim(), instructions: instructions.trim(), trigger: trigger() });
      onClose();
    } catch (x) {
      setErr(toErr(x));
    } finally {
      setBusy(false);
    }
  };
  const selected = bots.find((b) => b.id === bot);
  return (
    <Modal title={t('routines.new')} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label className="label" htmlFor="rt-bot">{t('library.bot')}</label>
          <select id="rt-bot" className="input" value={bot} onChange={(e) => setBot(e.target.value)}>
            {bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          {selected && !selected.proactive && <span className="faint" style={{ fontSize: 12 }}>{t('routines.notProactive')}</span>}
        </div>
        <div className="field">
          <label className="label" htmlFor="rt-name">{t('routines.name')}</label>
          <input id="rt-name" className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="rt-instr">{t('routines.instructions')}</label>
          <textarea id="rt-instr" className="input" required rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="rt-kind">{t('routines.trigger')}</label>
          <select id="rt-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as TriggerKind)}>
            {TRIGGER_KINDS.map((k) => <option key={k} value={k}>{t(`routines.triggers.${k}`)}</option>)}
          </select>
        </div>
        {kind === 'schedule' && (
          <div className="row wrap">
            <div className="field spacer">
              <label className="label" htmlFor="rt-cron">{t('routines.cron')}</label>
              <input id="rt-cron" className="input mono" dir="ltr" value={cron} onChange={(e) => setCron(e.target.value)} />
              <span className="faint" style={{ fontSize: 12 }}>{t('routines.cronHelp')}</span>
            </div>
            <TzField tz={tz} setTz={setTz} />
          </div>
        )}
        {kind === 'digest' && (
          <div className="row wrap">
            <div className="field">
              <label className="label" htmlFor="rt-time">{t('routines.time')}</label>
              <input id="rt-time" className="input" type="time" dir="ltr" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <TzField tz={tz} setTz={setTz} />
          </div>
        )}
        {kind === 'mail' && (
          <div className="field">
            <label className="label" htmlFor="rt-filter">{t('routines.filter')}</label>
            <input id="rt-filter" className="input" dir="ltr" placeholder="from:bank subject:invoice" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
        {kind === 'calendar' && (
          <div className="field">
            <label className="label" htmlFor="rt-lead">{t('routines.lead')}</label>
            <input id="rt-lead" className="input" type="number" min={1} max={1440} value={lead} onChange={(e) => setLead(Number(e.target.value) || 15)} />
          </div>
        )}
        {kind === 'watch' && (
          <div className="row wrap">
            <div className="field">
              <label className="label" htmlFor="rt-source">{t('routines.source')}</label>
              <select id="rt-source" className="input" value={source} onChange={(e) => setSource(e.target.value as 'drive' | 'computer')}>
                <option value="drive">{t('routines.sources.drive')}</option>
                <option value="computer">{t('routines.sources.computer')}</option>
              </select>
            </div>
            <div className="field spacer">
              <label className="label" htmlFor="rt-path">{source === 'drive' ? t('routines.driveName') : t('routines.folder')}</label>
              <input id="rt-path" className="input" dir="ltr" placeholder={source === 'drive' ? 'Invoices' : 'workspace/inbox'} value={path} onChange={(e) => setPath(e.target.value)} />
            </div>
          </div>
        )}
        {kind === 'webhook' && <p className="dim" style={{ margin: 0 }}>{t('routines.webhookHelp')}</p>}
        {kind === 'mcp' && (
          <div className="row wrap">
            <div className="field">
              <label className="label" htmlFor="rt-server">{t('routines.server')}</label>
              <select id="rt-server" className="input" value={serverId} onChange={(e) => setServerId(e.target.value)}>
                {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="field spacer">
              <label className="label" htmlFor="rt-uri">{t('routines.uri')}</label>
              <input id="rt-uri" className="input mono" dir="ltr" required value={uri} onChange={(e) => setUri(e.target.value)} />
            </div>
          </div>
        )}
        {err && <div role="alert" className="error">{err}</div>}
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy || !bot || !name.trim() || !instructions.trim()}>{t('common.add')}</button>
          <button className="btn ghost" type="button" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </form>
    </Modal>
  );
}

function TzField({ tz, setTz }: { tz: string; setTz(v: string): void }) {
  const { t } = useTranslation();
  return (
    <div className="field">
      <label className="label" htmlFor="rt-tz">{t('routines.tz')}</label>
      <input id="rt-tz" className="input" dir="ltr" value={tz} onChange={(e) => setTz(e.target.value)} />
    </div>
  );
}

/** The global "pause all proactivity" switch (FR-PRO-06). */
export function PauseAllButton({ compact }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { paused, setPaused } = useProactive();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={`btn ${paused ? 'primary' : ''} ${compact ? 'small' : ''}`}
      aria-pressed={paused}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void setPaused(!paused).finally(() => setBusy(false));
      }}
    >
      <Icon name={paused ? 'play' : 'pause'} size={16} /> {paused ? t('routines.resumeAll') : t('routines.pauseAll')}
    </button>
  );
}

export function RoutinesView({ setView }: ShellProps) {
  const { t } = useTranslation();
  const { routines, paused } = useProactive();
  const [adding, setAdding] = useState(false);
  const open = (convId: string, messageId?: string) => setView({ kind: 'conv', id: convId, focus: messageId });
  return (
    <>
      <header className="topbar">
        <button className="btn icon ghost only-narrow" aria-label={t('common.back')} onClick={() => setView({ kind: 'home' })}><Icon name="back" className="flip" /></button>
        <h2 className="spacer">{t('nav.routines')}</h2>
        <PauseAllButton compact />
        <button className="btn primary small" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> {t('routines.new')}</button>
      </header>
      <div className="messages">
        <div className="messages-inner stack">
          {paused && <p className="notice warn-box" role="status" style={{ margin: 0 }}>{t('routines.allPaused')}</p>}
          {routines.length === 0 && <div className="empty-state">{t('routines.empty')}</div>}
          {routines.map((r) => <RoutineCard key={r.id} r={r} open={open} />)}
        </div>
      </div>
      {adding && <NewRoutine onClose={() => setAdding(false)} />}
    </>
  );
}
