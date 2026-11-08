// Settings → Cloud computer (FR-UI-07, FR-PC-05..07): container runtime and image status,
// rebuild, auto-start, and the default limits for new Bot computers (owner only to change).
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ComputerLimits, ComputerSettings } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { useStore } from '../../state/store';
import { Icon } from '../../ui/Icon';
import { useErr } from './ChatSettings';

export function ComputerSection() {
  const { t } = useTranslation();
  const toErr = useErr();
  const { client, computerTick } = useChat();
  const owner = useStore((s) => s.user?.role === 'owner');
  const [s, setS] = useState<ComputerSettings | null>(null);
  const [limits, setLimits] = useState<ComputerLimits | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    const r = await client!.call<ComputerSettings>('GET', '/v1/computer/settings');
    setS(r);
    setLimits((l) => l ?? r.defaults);
  }, [client]);
  useEffect(() => void load().catch(() => undefined), [load, computerTick]);
  const patch = async (body: Record<string, unknown>) => {
    setErr(null);
    setSaved(false);
    try {
      const r = await client!.call<ComputerSettings>('PATCH', '/v1/computer/settings', body);
      setS(r);
      setLimits(r.defaults);
      setSaved(true);
    } catch (x) {
      setErr(toErr(x));
    }
  };
  if (!s || !limits) return <p className="dim">{t('common.loading')}</p>;
  const img = s.image;
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <Icon name="server" />
          <span className="spacer">{t('computer.settings.runtime')}</span>
          <span className={`badge ${s.runtime.available ? 'ok' : 'warn'}`}>{s.runtime.available ? `Podman ${s.runtime.version ?? ''}`.trim() : t('computer.settings.runtimeMissing')}</span>
        </div>
        {!s.runtime.available && <p className="dim" style={{ margin: 0 }}>{t('computer.settings.runtimeHelp')}</p>}
        {s.runtime.available && !s.hostIsolated && <p className="notice warn-box" style={{ margin: 0 }}>{t('computer.settings.notIsolated')}</p>}
        <div className="row">
          <Icon name="computer" />
          <span className="spacer">{t('computer.settings.image')}</span>
          <span className={`badge ${img.present && !img.building ? 'ok' : img.error ? 'warn' : ''}`} role="status">
            {img.building ? t('computer.settings.imageBuilding', { pct: Math.round((img.progress ?? 0) * 100) }) : img.error ? t('computer.settings.imageFailed') : img.present ? t('computer.settings.imageReady') : t('computer.settings.imageMissing')}
          </span>
        </div>
        {img.building && <div className="progress"><i style={{ width: `${Math.round((img.progress ?? 0.05) * 100)}%` }} /></div>}
        {owner && s.runtime.available && !img.building && (
          <div><button className="btn" onClick={async () => {
            setErr(null);
            try {
              setS(await client!.call<ComputerSettings>('POST', '/v1/computer/image', {}));
            } catch (x) {
              setErr(toErr(x));
            }
          }}><Icon name="refresh" size={16} /> {img.present ? t('computer.settings.rebuild') : t('computer.settings.build')}</button></div>
        )}
        <div className="row"><Icon name="bolt" /><span className="spacer">{t('computer.settings.gpu')}</span><span className="badge">{s.gpu ? t('computer.settings.gpuOn') : t('computer.settings.gpuOff')}</span></div>
      </div>

      <label className="list-row card" style={{ cursor: owner ? 'pointer' : 'default' }}>
        <Icon name="play" />
        <span className="spacer"><span style={{ display: 'block' }}>{t('computer.settings.autoStart')}</span><span className="faint" style={{ fontSize: 13 }}>{t('computer.settings.autoStartHelp')}</span></span>
        <input type="checkbox" role="switch" className="switch" disabled={!owner} checked={s.autoStart} onChange={(e) => void patch({ autoStart: e.target.checked })} />
      </label>

      <form className="card stack" onSubmit={(e) => { e.preventDefault(); void patch({ defaults: limits }); }}>
        <strong>{t('computer.settings.defaults')}</strong>
        <p className="faint" style={{ fontSize: 13, margin: 0 }}>{t('computer.settings.defaultsHelp')}</p>
        <div className="row wrap">
          <LimitField id="lim-cpu" label={t('computer.settings.cpus')} value={limits.cpus} step={0.5} min={0.5} max={64} disabled={!owner} onChange={(v) => setLimits({ ...limits, cpus: v })} />
          <LimitField id="lim-mem" label={t('computer.settings.memory')} value={limits.memoryMb / 1024} step={0.5} min={0.5} max={256} disabled={!owner} onChange={(v) => setLimits({ ...limits, memoryMb: Math.round(v * 1024) })} />
          <LimitField id="lim-disk" label={t('computer.settings.disk')} value={limits.diskGb} step={1} min={1} max={4096} disabled={!owner} onChange={(v) => setLimits({ ...limits, diskGb: Math.round(v) })} />
        </div>
        {owner && <div className="row"><button className="btn" type="submit">{t('common.save')}</button>{saved && <span className="faint">{t('common.done')}</span>}</div>}
      </form>
      {err && <div role="alert" className="error">{err}</div>}
    </div>
  );
}

function LimitField({ id, label, value, step, min, max, disabled, onChange }: { id: string; label: string; value: number; step: number; min: number; max: number; disabled: boolean; onChange(v: number): void }) {
  return (
    <div className="field spacer" style={{ minWidth: 120 }}>
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} className="input" type="number" dir="ltr" step={step} min={min} max={max} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
