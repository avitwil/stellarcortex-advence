// Settings → Skills (FR-UI-07, FR-SKL-01/02/04/05, FR-LRN-04/05) and Settings → Memory
// (FR-MEM-04/05, FR-LRN-06): installed and learned skills with usage counts, third-party installs
// with a full review before the owner approves, update diffs, export, the curator, the vault
// mode (owner only, with a warning), history and rollback.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CuratorRun, MemoryInfo, Skill, SkillExport, SkillReview, SkillUpdateCheck } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { useStore } from '../../state/store';
import { Icon } from '../../ui/Icon';
import { ago } from '../../lib/time';
import { useErr } from './ChatSettings';

function b64ToBlob(b64: string, type: string): Blob {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Blob([u8], { type });
}

function ReviewCard({ r, onDone }: { r: SkillReview; onDone(): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client } = useChat();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (what: 'approve' | 'reject') => {
    setBusy(true);
    setErr(null);
    try {
      await client!.call('POST', `/v1/skills/reviews/${r.id}/${what}`, {});
      onDone();
    } catch (x) {
      setErr(toErr(x));
    } finally {
      setBusy(false);
    }
  };
  const kinds = ['script', 'network', 'secrets', 'prompt_injection'] as const;
  return (
    <section className="card stack" aria-label={t('skills.review.title', { name: r.name || '?' })}>
      <div className="row wrap">
        <Icon name="skill" />
        <strong className="spacer">{r.skillId ? t('skills.review.update', { name: r.name }) : t('skills.review.title', { name: r.name || '?' })}</strong>
        <span className="badge">{r.source.kind}</span>
      </div>
      <p className="faint mono" style={{ margin: 0, fontSize: 13, wordBreak: 'break-all' }}>
        {r.source.ref}{r.source.sha ? ` @ ${r.source.sha.slice(0, 12)}` : ''}
      </p>
      {r.errors.length > 0 && (
        <div className="notice warn-box" role="alert">
          <strong>{t('skills.review.invalid')}</strong>
          <ul>{r.errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      <div className="stack" aria-label={t('skills.review.findings')}>
        <strong>{t('skills.review.findings')}</strong>
        {r.findings.length === 0 ? <p className="dim" style={{ margin: 0 }}>{t('skills.review.noFindings')}</p> : kinds.map((k) => {
          const f = r.findings.filter((x) => x.kind === k);
          if (!f.length) return null;
          return (
            <details key={k} open={k !== 'script'}>
              <summary><span className={`badge ${k === 'script' ? '' : 'warn'}`}>{t(`skills.review.kind.${k}`)}</span> {f.length}</summary>
              <ul className="mono" style={{ fontSize: 12 }}>{f.map((x, i) => <li key={i}>{x.file}:{x.line} {x.excerpt}</li>)}</ul>
            </details>
          );
        })}
      </div>
      <details>
        <summary>{t('skills.review.files', { n: r.files.length })}</summary>
        <ul className="mono" style={{ fontSize: 12 }}>{r.files.map((f) => <li key={f.path}>{f.path} ({f.size} B)</li>)}</ul>
        {r.skipped.length > 0 && <p className="faint" style={{ fontSize: 12 }}>{t('skills.review.skipped', { files: r.skipped.join(', ') })}</p>}
      </details>
      {r.diff !== null ? (
        <details open>
          <summary>{t('skills.review.diff')}</summary>
          <pre className="code" dir="ltr" aria-label={t('skills.review.diff')}>{r.diff || t('skills.review.noDiff')}</pre>
        </details>
      ) : (
        <details open>
          <summary>SKILL.md</summary>
          <pre className="code" dir="ltr" aria-label="SKILL.md">{r.skillMd}</pre>
        </details>
      )}
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>{t('skills.review.approveHelp')}</p>
      <div className="row">
        <button className="btn primary" disabled={busy || r.errors.length > 0} onClick={() => void act('approve')}><Icon name="check" size={16} /> {r.skillId ? t('skills.review.approveUpdate') : t('skills.review.approve')}</button>
        <button className="btn" disabled={busy} onClick={() => void act('reject')}>{t('skills.review.reject')}</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}

function SkillRow({ s, botName, onChange, onReview }: { s: Skill; botName: string; onChange(): void; onReview(r: SkillReview): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client } = useChat();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [zip, setZip] = useState<string | null>(null);
  useEffect(() => () => void (zip && URL.revokeObjectURL(zip)), [zip]);
  const flag = async (body: Record<string, boolean>) => {
    try {
      await client!.call('PATCH', `/v1/skills/${s.id}`, body);
      onChange();
    } catch (x) {
      setErr(toErr(x));
    }
  };
  return (
    <li className="card stack" aria-label={s.name}>
      <div className="row wrap">
        <Icon name="skill" />
        <span className="spacer">
          <strong>{s.name}</strong> <span className={`badge ${s.status === 'active' ? 'ok' : s.status === 'stale' ? 'warn' : ''}`}>{t(`skills.status.${s.status}`)}</span>
          <span className="faint" style={{ display: 'block', fontSize: 13 }}>{s.description}</span>
        </span>
      </div>
      <div className="faint" style={{ fontSize: 13 }}>
        {s.botId ? t('skills.byBot', { bot: botName }) : t('skills.installed', { source: s.source.ref })}
        {' · '}{t('skills.counts', { views: s.views, uses: s.uses, patches: s.patches })}
        {' · '}{t('skills.lastUsed', { when: s.lastUsed ? ago(t, s.lastUsed) : t('skills.never') })}
      </div>
      <div className="row wrap">
        <label className="row"><input type="checkbox" role="switch" className="switch" checked={s.pinned} onChange={(e) => void flag({ pinned: e.target.checked })} /> {t('skills.pin')}</label>
        <label className="row"><input type="checkbox" role="switch" className="switch" checked={s.locked} onChange={(e) => void flag({ locked: e.target.checked })} /> {t('skills.lock')}</label>
        <span className="spacer" />
        {s.source.kind !== 'bot' && (
          <button className="btn small" onClick={async () => {
            setErr(null);
            setNote(null);
            try {
              const r = await client!.call<SkillUpdateCheck>('POST', `/v1/skills/${s.id}/check-update`, {});
              if (r.review) onReview(r.review);
              else setNote(t('skills.upToDate'));
            } catch (x) {
              setErr(toErr(x));
            }
          }}><Icon name="refresh" size={14} /> {t('skills.checkUpdate')}</button>
        )}
        {zip ? (
          <a className="btn small" href={zip} download={`${s.name}.zip`}><Icon name="download" size={14} /> {s.name}.zip</a>
        ) : (
          <button className="btn small" onClick={async () => {
            try {
              const e = await client!.call<SkillExport>('GET', `/v1/skills/${s.id}/export`);
              setZip(URL.createObjectURL(b64ToBlob(e.zipB64, 'application/zip')));
            } catch (x) {
              setErr(toErr(x));
            }
          }}><Icon name="download" size={14} /> {t('skills.export')}</button>
        )}
      </div>
      {note && <p className="dim" role="status" style={{ margin: 0 }}>{note}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </li>
  );
}

function CuratorCard({ onChange }: { onChange(): void }) {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client } = useChat();
  const [runs, setRuns] = useState<CuratorRun[]>([]);
  const [plan, setPlan] = useState<CuratorRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => setRuns(await client!.call<CuratorRun[]>('GET', '/v1/skills/curator')), [client]);
  useEffect(() => void load().catch(() => undefined), [load]);
  const go = async (f: () => Promise<unknown>) => {
    setErr(null);
    try {
      await f();
      await load();
      onChange();
    } catch (x) {
      setErr(toErr(x));
    }
  };
  const describe = (r: CuratorRun) => r.actions.length ? r.actions.map((a) => t(`skills.curator.action.${a.reason}`, { name: a.name, into: a.into ?? '' })).join(', ') : t('skills.curator.nothing');
  return (
    <section className="card stack" aria-label={t('skills.curator.title')}>
      <strong>{t('skills.curator.title')}</strong>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>{t('skills.curator.help')}</p>
      <div className="row wrap">
        <button className="btn" onClick={() => void go(async () => setPlan(await client!.call<CuratorRun>('POST', '/v1/skills/curator/run', { dryRun: true })))}>{t('skills.curator.dryRun')}</button>
        <button className="btn" onClick={() => void go(async () => {
          await client!.call('POST', '/v1/skills/curator/run', { dryRun: false });
          setPlan(null);
        })}>{t('skills.curator.run')}</button>
      </div>
      {plan && <p className="notice" role="status">{t('skills.curator.plan')}: {describe(plan)}</p>}
      {runs.filter((r) => !r.dryRun).slice(0, 10).map((r) => (
        <div key={r.id} className="row wrap" style={{ fontSize: 13 }}>
          <span className="spacer">{ago(t, r.at)}: {describe(r)}</span>
          {r.rolledBack ? <span className="badge">{t('skills.curator.rolledBack')}</span> : r.actions.length > 0 && (
            <button className="btn small" onClick={() => void go(() => client!.call('POST', '/v1/skills/curator/rollback', { runId: r.id }))}>{t('skills.curator.rollback')}</button>
          )}
        </div>
      ))}
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}

export function SkillsSection() {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client, bots } = useChat();
  const owner = useStore((s) => s.user?.role === 'owner');
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [reviews, setReviews] = useState<SkillReview[]>([]);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [s, r] = await Promise.all([client!.call<Skill[]>('GET', '/v1/skills'), client!.call<SkillReview[]>('GET', '/v1/skills/reviews')]);
    setSkills(s);
    setReviews(r);
  }, [client]);
  useEffect(() => void load().catch(() => undefined), [load]);
  if (!skills) return <p className="dim">{t('common.loading')}</p>;
  const botName = (id: string | null) => bots.find((b) => b.id === id)?.name ?? t('skills.aBot');
  const shown = [...skills].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.status === 'archived' ? 1 : 0) - (b.status === 'archived' ? 1 : 0) || a.name.localeCompare(b.name));
  return (
    <div className="stack">
      <form className="card stack" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          const r = await client!.call<SkillReview>('POST', '/v1/skills/install', { source: source.trim() });
          setReviews((x) => [...x, r]);
          setSource('');
        } catch (x) {
          setErr(toErr(x));
        } finally {
          setBusy(false);
        }
      }}>
        <label htmlFor="skill-source"><strong>{t('skills.install.title')}</strong></label>
        <p className="faint" style={{ margin: 0, fontSize: 13 }}>{owner ? t('skills.install.helpOwner') : t('skills.install.help')}</p>
        <div className="row">
          <input id="skill-source" className="input spacer" dir="ltr" value={source} placeholder="owner/repo/path" onChange={(e) => setSource(e.target.value)} />
          <button className="btn primary" disabled={busy || source.trim().length < 3}>{busy ? t('common.loading') : t('skills.install.check')}</button>
        </div>
        {err && <p className="error" role="alert">{err}</p>}
      </form>
      {reviews.map((r) => <ReviewCard key={r.id} r={r} onDone={() => void load()} />)}
      {shown.length === 0 ? <p className="dim">{t('skills.none')}</p> : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {shown.map((s) => <SkillRow key={s.id} s={s} botName={botName(s.botId)} onChange={() => void load()} onReview={(r) => setReviews((x) => [...x, r])} />)}
        </ul>
      )}
      <CuratorCard onChange={() => void load()} />
    </div>
  );
}

export function MemorySection() {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client } = useChat();
  const owner = useStore((s) => s.user?.role === 'owner');
  const [m, setM] = useState<MemoryInfo | null>(null);
  const [confirmPlain, setConfirmPlain] = useState(false);
  const [restore, setRestore] = useState<string | null>(null);
  const [days, setDays] = useState<{ stale: number; archive: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    const r = await client!.call<MemoryInfo>('GET', '/v1/memory');
    setM(r);
    setDays((d) => d ?? { stale: r.curator.staleDays, archive: r.curator.archiveDays });
  }, [client]);
  useEffect(() => void load().catch(() => undefined), [load]);
  const patch = async (body: Record<string, unknown>) => {
    setErr(null);
    setSaved(false);
    try {
      setM(await client!.call<MemoryInfo>('PATCH', '/v1/memory/settings', body));
      setSaved(true);
    } catch (x) {
      setErr(toErr(x));
    }
  };
  if (!m || !days) return <p className="dim">{t('common.loading')}</p>;
  return (
    <div className="stack">
      <section className="card stack" aria-label={t('memory.vault')}>
        <div className="row">
          <Icon name="shield" />
          <span className="spacer">{t('memory.vault')}</span>
          <span className={`badge ${m.mode === 'encrypted' ? 'ok' : 'warn'}`} role="status">{t(`memory.mode.${m.mode}`)}</span>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 13 }}>{t('memory.notes', { n: m.notes })}</p>
        {m.mode === 'plain' && m.vaultPath && <p className="notice" style={{ margin: 0 }}>{t('memory.plainWhere')} <code dir="ltr">{m.vaultPath}</code></p>}
        {owner && (m.mode === 'encrypted' ? (
          confirmPlain ? (
            <div className="notice warn-box stack" role="alert">
              <strong>{t('memory.plainWarnTitle')}</strong>
              <span>{t('memory.plainWarn')}</span>
              <div className="row">
                <button className="btn danger" onClick={() => void patch({ mode: 'plain' }).then(() => setConfirmPlain(false))}>{t('memory.plainConfirm')}</button>
                <button className="btn" onClick={() => setConfirmPlain(false)}>{t('common.cancel')}</button>
              </div>
            </div>
          ) : <div><button className="btn" onClick={() => setConfirmPlain(true)}>{t('memory.toPlain')}</button></div>
        ) : <div><button className="btn primary" onClick={() => void patch({ mode: 'encrypted' })}>{t('memory.toEncrypted')}</button></div>)}
      </section>

      <label className="list-row card" style={{ cursor: owner ? 'pointer' : 'default' }}>
        <Icon name="sparkle" />
        <span className="spacer"><span style={{ display: 'block' }}>{t('memory.consolidation')}</span><span className="faint" style={{ fontSize: 13 }}>{t('memory.consolidationHelp')}</span></span>
        <input type="checkbox" role="switch" className="switch" disabled={!owner} checked={m.consolidation} onChange={(e) => void patch({ consolidation: e.target.checked })} />
      </label>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); void patch({ staleDays: days.stale, archiveDays: days.archive }); }}>
        <strong>{t('memory.curatorDays')}</strong>
        <div className="row wrap">
          <label className="stack">{t('memory.staleDays')}<input className="input" type="number" min={1} disabled={!owner} value={days.stale} onChange={(e) => setDays({ ...days, stale: Number(e.target.value) })} /></label>
          <label className="stack">{t('memory.archiveDays')}<input className="input" type="number" min={2} disabled={!owner} value={days.archive} onChange={(e) => setDays({ ...days, archive: Number(e.target.value) })} /></label>
        </div>
        {owner && <div><button className="btn">{t('common.save')}</button></div>}
      </form>

      <section className="card stack" aria-label={t('memory.history')}>
        <strong>{t('memory.history')}</strong>
        {m.history.length === 0 ? <p className="dim" style={{ margin: 0 }}>{t('memory.noHistory')}</p> : m.history.map((c, i) => (
          <div key={c.oid} className="row wrap" style={{ fontSize: 13 }}>
            <span className="spacer"><span className="mono faint">{c.oid.slice(0, 8)}</span> {c.message} <span className="faint">· {ago(t, c.at)}</span></span>
            {i > 0 && (restore === c.oid ? (
              <>
                <button className="btn small danger" onClick={async () => {
                  setErr(null);
                  try {
                    setM(await client!.call<MemoryInfo>('POST', '/v1/memory/rollback', { oid: c.oid }));
                    setRestore(null);
                  } catch (x) {
                    setErr(toErr(x));
                  }
                }}>{t('memory.restoreConfirm')}</button>
                <button className="btn small" onClick={() => setRestore(null)}>{t('common.cancel')}</button>
              </>
            ) : <button className="btn small" onClick={() => setRestore(c.oid)}>{t('memory.restore')}</button>)}
          </div>
        ))}
      </section>
      {saved && <p className="dim" role="status">{t('common.saved')}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}
