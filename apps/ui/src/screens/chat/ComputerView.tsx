// Bot computer (FR-UI-05, FR-PC-06): status with "preparing" progress, start and stop, the live
// desktop through noVNC, and take over / hand back. While the owner has taken over, the Bot's
// computer actions wait on the server.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Bot, ComputerState, ComputerView as ViewCreds } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { useStore } from '../../state/store';
import { platform } from '../../platform';
import { VncChannel } from '../../api/vnc-channel';
import { ApiError } from '../../api/client';
import { Icon } from '../../ui/Icon';
import { Modal } from './Modal';

export function computerLabel(t: (k: string, o?: Record<string, unknown>) => string, st: ComputerState | undefined): string {
  if (!st) return t('computer.state.stopped');
  if (st.state === 'running' && st.takeover) return t('computer.state.takeover');
  if (st.state === 'preparing' && st.progress != null) return t('computer.state.preparingPct', { pct: Math.round(st.progress * 100) });
  return t(`computer.state.${st.state}`);
}

export function ComputerPanel({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const { t } = useTranslation();
  const { client, computers, loadComputer } = useChat();
  const owner = useStore((s) => s.user?.role === 'owner');
  const st = computers[bot.id];
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void loadComputer(bot.id), [bot.id, loadComputer]);

  const act = async (what: 'start' | 'stop' | 'takeover' | 'handback') => {
    setBusy(true);
    setErr(null);
    try {
      const next = await client!.call<ComputerState>('POST', `/v1/bots/${bot.id}/computer/${what}`, {});
      useChat.setState((s) => ({ computers: { ...s.computers, [bot.id]: next } }));
    } catch (e) {
      setErr(e instanceof ApiError ? t(`errors.${e.code}`, { defaultValue: t('common.error') }) : t('common.error'));
    } finally {
      setBusy(false);
    }
  };

  const running = st?.state === 'running';
  const takeover = !!st?.takeover;
  return (
    <Modal title={t('computer.title', { name: bot.name })} onClose={onClose} full>
      <div className="row wrap" style={{ marginBlockEnd: 10 }}>
        <span className={`badge ${running ? 'ok' : st?.state === 'error' || st?.state === 'disk_full' ? 'warn' : ''}`} role="status">{computerLabel(t, st)}</span>
        {st?.gpu && <span className="badge">{t('computer.gpu')}</span>}
        <span className="spacer" />
        {running && !takeover && <button className="btn" disabled={busy} onClick={() => void act('takeover')}><Icon name="hand" size={16} /> {t('computer.takeOver')}</button>}
        {running && takeover && <button className="btn primary" disabled={busy} onClick={() => void act('handback')}><Icon name="reply" size={16} className="flip" /> {t('computer.handBack')}</button>}
        {running && <button className="btn" disabled={busy} onClick={() => void act('stop')}><Icon name="pause" size={16} /> {t('computer.stop')}</button>}
        {st && (st.state === 'stopped' || st.state === 'error') && <button className="btn primary" disabled={busy} onClick={() => void act('start')}><Icon name="play" size={16} /> {t('computer.start')}</button>}
      </div>
      {takeover && <p className="notice warn-box" style={{ marginBlockStart: 0 }}><Icon name="hand" size={16} /> {t('computer.takeoverHelp')}</p>}
      {err && <div role="alert" className="error">{err}</div>}
      <div className={`vnc-wrap ${takeover ? 'interactive' : ''}`}>
        {running ? <LiveView botId={bot.id} interactive={takeover} /> : <StateOverlay st={st} owner={owner} />}
      </div>
      {st && <div className="faint" style={{ fontSize: 12, marginBlockStart: 8 }}>{t('computer.limits', { cpus: st.limits.cpus, memory: (st.limits.memoryMb / 1024).toFixed(1), disk: st.limits.diskGb })}</div>}
    </Modal>
  );
}

function StateOverlay({ st, owner }: { st: ComputerState | undefined; owner: boolean }) {
  const { t } = useTranslation();
  if (!st) return <div className="vnc-overlay">{t('common.loading')}</div>;
  return (
    <div className="vnc-overlay">
      <div className="stack" style={{ alignItems: 'center' }}>
        <Icon name="computer" size={40} />
        <div>{computerLabel(t, st)}</div>
        {(st.state === 'preparing' || st.state === 'starting') && (
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={st.progress != null ? Math.round(st.progress * 100) : undefined}>
            <i style={{ width: `${Math.round((st.progress ?? 0.1) * 100)}%` }} />
          </div>
        )}
        {st.state === 'unavailable' && <div style={{ maxWidth: 420 }}>{t(owner ? 'computer.unavailableOwner' : 'computer.unavailable')}</div>}
        {st.state === 'disk_full' && <div style={{ maxWidth: 420 }}>{t('computer.diskFull')}</div>}
        {st.state === 'error' && st.detail && <div style={{ maxWidth: 420 }}>{t(`computer.detail.${st.detail}`, { defaultValue: t('computer.detail.unknown') })}</div>}
        <div className="faint" style={{ fontSize: 13 }}>{t('computer.chatStillWorks')}</div>
      </div>
    </div>
  );
}

type RfbLike = { viewOnly: boolean; scaleViewport: boolean; disconnect(): void; focus(): void; addEventListener(t: string, f: (e: Event) => void): void };

function LiveView({ botId, interactive }: { botId: string; interactive: boolean }) {
  const { t } = useTranslation();
  const client = useChat((s) => s.client);
  const el = useRef<HTMLDivElement>(null);
  const rfb = useRef<RfbLike | null>(null);
  const [phase, setPhase] = useState<'connecting' | 'live' | 'closed'>('connecting');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!client || !el.current) return;
    let live = true;
    setPhase('connecting');
    void (async () => {
      try {
        const [{ password }, mod] = await Promise.all([
          client.call<ViewCreds>('GET', `/v1/bots/${botId}/computer/view`),
          import('@novnc/novnc'),
        ]);
        if (!live || !el.current) return;
        const r = new mod.default(el.current, new VncChannel(client, platform(), botId), { credentials: { password }, shared: true }) as unknown as RfbLike;
        r.scaleViewport = true;
        r.viewOnly = true;
        r.addEventListener('connect', () => live && setPhase('live'));
        r.addEventListener('disconnect', () => live && setPhase('closed'));
        rfb.current = r;
      } catch {
        if (live) setPhase('closed');
      }
    })();
    return () => {
      live = false;
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [client, botId, attempt]);

  // Mouse and keyboard reach the Bot's desktop only during take-over.
  useEffect(() => {
    const r = rfb.current;
    if (!r) return;
    r.viewOnly = !interactive;
    if (interactive) r.focus();
  }, [interactive, phase]);

  return (
    <>
      <div ref={el} className="vnc-screen" aria-label={t('computer.screen')} />
      {phase !== 'live' && (
        <div className="vnc-overlay">
          {phase === 'connecting' ? t('computer.connecting') : (
            <div className="stack" style={{ alignItems: 'center' }}>
              <div>{t('computer.disconnected')}</div>
              <button className="btn" onClick={() => setAttempt((a) => a + 1)}><Icon name="refresh" size={16} /> {t('common.retry')}</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
