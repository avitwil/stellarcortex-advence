// Chat view (FR-UI-02): messages with markdown, attachments, @mentions, threads, reactions,
// per-conversation drafts and streaming replies.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_ATTACHMENT_BYTES, type Attachment, type AttachmentData, type Bot, type EngineStep, type Message } from '@advence/protocol';
import { useChat } from '../../state/chat';
import { useStore } from '../../state/store';
import { Icon } from '../../ui/Icon';
import { Markdown } from './Markdown';
import { BotAvatar } from './BotAvatar';
import { BotProfile } from './BotProfile';
import { NewGroup } from './NewGroup';
import { ComputerPanel } from './ComputerView';
import type { ShellProps } from '../shell-registry';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '👀'];

export function ChatView({ view, setView }: ShellProps) {
  const { t } = useTranslation();
  const convId = view.id!;
  const { conversations, messages, setActive, loadMessages, botById, bots } = useChat();
  const conv = conversations.find((c) => c.id === convId);
  const list = messages[convId];
  const [thread, setThread] = useState<string | null>(null);
  const [profile, setProfile] = useState<Bot | null>(null);
  const [editGroup, setEditGroup] = useState(false);
  const [computer, setComputer] = useState<Bot | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    setActive(convId);
    setThread(null);
    setHasMore(true);
    atBottom.current = true;
    return () => setActive(null);
  }, [convId, setActive]);

  // Keep the view pinned to the newest message while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [list]);

  useEffect(() => {
    const focus = (view as { focus?: string }).focus;
    if (!focus || !list) return;
    const el = document.getElementById(`m-${focus}`);
    if (el) {
      atBottom.current = false;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('focused');
      setTimeout(() => el.classList.remove('focused'), 2000);
    }
  }, [view, list]);

  if (!conv) return <div className="empty-state">{t('common.loading')}</div>;
  const members = conv.botIds.map((id) => botById(id)).filter((b): b is Bot => !!b);
  const direct = conv.kind === 'direct' ? members[0] : undefined;

  return (
    <div className={`chat ${thread ? 'thread-open' : ''}`}>
      <div className="chat-main">
        <header className="topbar">
          <button className="btn icon ghost only-narrow" aria-label={t('common.back')} onClick={() => setView({ kind: 'home' })}><Icon name="back" className="flip" /></button>
          {direct ? (
            <button className="title-btn" onClick={() => setProfile(direct)} aria-label={t('bot.openProfile', { name: direct.name })}>
              <BotAvatar bot={direct} />
              <h2>{direct.name}</h2>
            </button>
          ) : (
            <button className="title-btn" onClick={() => setEditGroup(true)} aria-label={t('group.edit')}>
              <span className="avatar group" aria-hidden="true"><Icon name="group" size={16} /></span>
              <span className="stack" style={{ gap: 0, alignItems: 'flex-start' }}>
                <h2>{conv.title}</h2>
                <span className="faint" style={{ fontSize: 12 }}>{members.map((m) => m.name).join(', ')}</span>
              </span>
            </button>
          )}
          <span className="spacer" />
          {!direct && members.map((m) => (
            <button key={m.id} className="btn icon ghost" onClick={() => setProfile(m)} aria-label={t('bot.openProfile', { name: m.name })}><BotAvatar bot={m} /></button>
          ))}
          {direct && <button className="btn icon ghost" onClick={() => setComputer(direct)} aria-label={t('computer.open', { name: direct.name })} title={t('computer.open', { name: direct.name })}><Icon name="computer" /></button>}
        </header>
        <div className="messages" ref={scroller} onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}>
          <div className="messages-inner">
            {list && list.length >= 50 && hasMore && (
              <button className="btn ghost" style={{ alignSelf: 'center' }} onClick={async () => { atBottom.current = false; setHasMore(await loadMessages(convId, true)); }}>{t('chat.loadEarlier')}</button>
            )}
            {list && list.length === 0 && <div className="empty-state">{t('chat.empty')}</div>}
            {list?.map((m) => <MessageItem key={m.id} m={m} onThread={() => setThread(m.id)} onBot={(b) => setProfile(b)} />)}
          </div>
        </div>
        <Composer convId={convId} parentId={null} members={conv.kind === 'group' ? members : []} placeholderName={direct?.name ?? conv.title} onSent={() => (atBottom.current = true)} />
      </div>
      {thread && <ThreadPanel convId={convId} parentId={thread} members={conv.kind === 'group' ? members : []} onClose={() => setThread(null)} onBot={(b) => setProfile(b)} />}
      {profile && <BotProfile bot={bots.find((b) => b.id === profile.id) ?? profile} onClose={() => setProfile(null)} onLibrary={() => { setProfile(null); setView({ kind: 'library', id: profile.id }); }} onComputer={() => { setComputer(profile); setProfile(null); }} onRoutines={() => { setProfile(null); setView({ kind: 'routines' }); }} onActivity={() => { setProfile(null); setView({ kind: 'activity', id: profile.id }); }} />}
      {computer && <ComputerPanel bot={computer} onClose={() => setComputer(null)} />}
      {editGroup && conv.kind === 'group' && <NewGroup conv={conv} onClose={(id) => { setEditGroup(false); if (!id) setView({ kind: 'home' }); }} />}
    </div>
  );
}

function ThreadPanel({ convId, parentId, members, onClose, onBot }: { convId: string; parentId: string; members: Bot[]; onClose(): void; onBot(b: Bot): void }) {
  const { t } = useTranslation();
  const { threads, messages, loadThread } = useChat();
  const parent = messages[convId]?.find((m) => m.id === parentId);
  const replies = threads[parentId];
  useEffect(() => void loadThread(convId, parentId), [convId, parentId, loadThread]);
  return (
    <aside className="thread-panel" aria-label={t('chat.thread')}>
      <header className="topbar">
        <h2 className="spacer">{t('chat.thread')}</h2>
        <button className="btn icon ghost" aria-label={t('common.close')} onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="messages">
        <div className="messages-inner">
          {parent && <MessageItem m={parent} onBot={onBot} inThread />}
          <div className="thread-divider faint">{t('chat.replies', { count: replies?.length ?? 0 })}</div>
          {replies?.map((m) => <MessageItem key={m.id} m={m} onBot={onBot} inThread />)}
        </div>
      </div>
      <Composer convId={convId} parentId={parentId} members={members} placeholderName={t('chat.thread')} />
    </aside>
  );
}

function MessageItem({ m, onThread, onBot, inThread }: { m: Message; onThread?: () => void; onBot(b: Bot): void; inThread?: boolean }) {
  const { t } = useTranslation();
  const { client, botById } = useChat();
  const user = useStore((s) => s.user);
  const [picker, setPicker] = useState(false);
  const bot = botById(m.botId);
  const react = async (emoji: string) => {
    setPicker(false);
    await client!.call('POST', `/v1/messages/${m.id}/reactions`, { emoji });
  };
  if (m.author === 'system') {
    return (
      <div className="msg system" id={`m-${m.id}`}>
        <div className="system-card"><Icon name="reply" size={16} /> <Markdown text={m.text} /></div>
      </div>
    );
  }
  const mine = m.author === 'user';
  const name = mine ? user?.name ?? '' : bot?.name ?? t('bot.deleted');
  return (
    <div className={`msg ${mine ? 'user' : 'bot'}`} id={`m-${m.id}`}>
      {!mine && (bot ? <button className="avatar-btn" onClick={() => onBot(bot)} aria-label={t('bot.openProfile', { name })}><BotAvatar bot={bot} /></button> : <span className="avatar" aria-hidden="true">?</span>)}
      <div className="bubble-col">
        {!mine && <div className="author">{name}</div>}
        <div className="bubble">
          {m.text && (mine ? <div className="plain" dir="auto">{m.text}</div> : <Markdown text={m.text} />)}
          {m.steps && m.steps.length > 0 && <EngineSteps steps={m.steps} />}
          {m.status === 'streaming' && !m.text && <span className="typing" role="status" aria-label={t('chat.thinking', { name })}><i /><i /><i /></span>}
          {m.attachments.length > 0 && <Attachments items={m.attachments} />}
          {m.status === 'error' && (
            <div className="msg-error" role="status">
              <Icon name="close" size={14} /> {t(`errors.reply.${m.error ?? 'failed'}`, { defaultValue: t('errors.reply.failed') })}
            </div>
          )}
        </div>
        <div className="msg-actions">
          {m.reactions.map((r) => (
            <button key={r.emoji} className={`reaction ${r.mine ? 'mine' : ''}`} aria-pressed={r.mine} onClick={() => void react(r.emoji)}>{r.emoji} {r.count}</button>
          ))}
          {m.status === 'streaming' && (
            <button className="btn ghost small" onClick={() => void client!.call('POST', `/v1/messages/${m.id}/stop`, {})}><Icon name="pause" size={14} /> {t('chat.stop')}</button>
          )}
          {m.status !== 'streaming' && (
            <span className="hover-actions">
              <span style={{ position: 'relative' }}>
                <button className="btn icon ghost small" aria-label={t('chat.react')} aria-expanded={picker} onClick={() => setPicker(!picker)}><Icon name="smile" size={16} /></button>
                {picker && (
                  <span className="menu reactions-menu" role="menu">
                    {QUICK_REACTIONS.map((e) => <button key={e} role="menuitem" className="btn ghost small" onClick={() => void react(e)}>{e}</button>)}
                  </span>
                )}
              </span>
              {!inThread && onThread && (
                <button className="btn ghost small" onClick={onThread}><Icon name="reply" size={16} className="flip" /> {m.replyCount > 0 ? t('chat.replies', { count: m.replyCount }) : t('chat.replyInThread')}</button>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Coding engine activity (FR-CODE-04): commands with their output, and file diffs. */
export function EngineSteps({ steps }: { steps: EngineStep[] }) {
  const { t } = useTranslation();
  return (
    <div className="steps" aria-label={t('steps.label')}>
      {steps.map((s) => (
        <details key={s.id} className={`step ${s.status}`}>
          <summary>
            <Icon name={s.kind === 'command' ? 'terminal' : s.kind === 'diff' ? 'file' : s.kind === 'plan' ? 'routine' : 'code'} size={14} />
            <span className="step-title">{s.title}</span>
            <span className="faint">{s.status === 'running' ? t('steps.running') : s.kind === 'command' && s.exitCode != null ? t('steps.exit', { code: s.exitCode }) : s.status === 'failed' ? t('steps.failed') : ''}</span>
          </summary>
          {s.body && <pre>{s.kind === 'diff' ? s.body.split('\n').map((l, i) => <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : undefined}>{l}{'\n'}</span>) : s.body}</pre>}
        </details>
      ))}
    </div>
  );
}

function Attachments({ items }: { items: Attachment[] }) {
  return (
    <div className="attachments">
      {items.map((a) => <AttachmentView key={a.id} a={a} />)}
    </div>
  );
}

const blobCache = new Map<string, string>();

function useBlobUrl(a: Attachment, load: boolean): string | null {
  const client = useChat((s) => s.client);
  const [url, setUrl] = useState<string | null>(blobCache.get(a.id) ?? null);
  useEffect(() => {
    if (!load || url || !client) return;
    let live = true;
    client.call<AttachmentData>('GET', `/v1/attachments/${a.id}`).then((d) => {
      const bin = Uint8Array.from(atob(d.dataB64), (c) => c.charCodeAt(0));
      const u = URL.createObjectURL(new Blob([bin], { type: d.mime }));
      blobCache.set(a.id, u);
      if (live) setUrl(u);
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [a.id, load, url, client]);
  return url;
}

function AttachmentView({ a }: { a: Attachment }) {
  const { t } = useTranslation();
  const isImage = /^image\/(png|jpeg|gif|webp)$/.test(a.mime);
  const [want, setWant] = useState(isImage && a.size < 8 * 1024 * 1024);
  const url = useBlobUrl(a, want);
  if (isImage && url) return <img className="att-image" src={url} alt={a.name} />;
  return (
    <span className="att-chip">
      <Icon name={isImage ? 'image' : 'file'} size={16} />
      <span className="ellipsis">{a.name}</span>
      <span className="faint">{formatSize(a.size)}</span>
      {url ? (
        <a className="btn ghost small" href={url} download={a.name}><Icon name="download" size={14} /> {t('chat.download')}</a>
      ) : (
        <button className="btn ghost small" onClick={() => setWant(true)}><Icon name="download" size={14} /> {t('chat.download')}</button>
      )}
    </span>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Upload { key: string; name: string; state: 'uploading' | 'done' | 'error'; att?: Attachment }

function Composer({ convId, parentId, members, placeholderName, onSent }: { convId: string; parentId: string | null; members: Bot[]; placeholderName: string; onSent?: () => void }) {
  const { t } = useTranslation();
  const { client, send } = useChat();
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ q: string; at: number } | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  const draftKey = parentId ? null : convId; // drafts are per conversation (top level)

  // Drafts persist on the server, so they survive restarts and follow the user across devices.
  useEffect(() => {
    loaded.current = false;
    setText('');
    if (!draftKey || !client) {
      loaded.current = true;
      return;
    }
    let live = true;
    client.call<{ text: string }>('GET', `/v1/conversations/${draftKey}/draft`).then((d) => {
      if (live) {
        setText(d.text);
        loaded.current = true;
      }
    }, () => (loaded.current = true));
    return () => {
      live = false;
    };
  }, [draftKey, client]);
  useEffect(() => {
    if (!draftKey || !loaded.current || !client) return;
    const h = setTimeout(() => void client.call('PUT', `/v1/conversations/${draftKey}/draft`, { text }).catch(() => undefined), 600);
    return () => clearTimeout(h);
  }, [text, draftKey, client]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLocaleLowerCase();
    return members.filter((b) => b.name.toLocaleLowerCase().startsWith(q)).slice(0, 6);
  }, [mention, members]);

  const onChange = (v: string, caret: number) => {
    setText(v);
    if (!members.length) return;
    const before = v.slice(0, caret);
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
    setMention(m ? { q: m[2]!, at: caret - m[2]!.length - 1 } : null);
  };

  const pick = (b: Bot) => {
    if (!mention) return;
    const end = mention.at + 1 + mention.q.length;
    const v = `${text.slice(0, mention.at)}@${b.name} ${text.slice(end)}`;
    setText(v);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = mention.at + b.name.length + 2;
      area.current?.focus();
      area.current?.setSelectionRange(pos, pos);
    });
  };

  const addFiles = async (files: FileList | null) => {
    if (!files || !client) return;
    setErr(null);
    for (const f of Array.from(files).slice(0, 10)) {
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setErr(t('chat.tooLarge', { name: f.name }));
        continue;
      }
      const key = `${f.name}-${Date.now()}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: f.name, state: 'uploading' }]);
      try {
        const dataB64 = await toBase64(f);
        const att = await client.call<Attachment>('POST', '/v1/attachments', { name: f.name, mime: f.type || 'application/octet-stream', dataB64 });
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'done', att } : x)));
      } catch {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, state: 'error' } : x)));
      }
    }
  };

  const ready = uploads.filter((u) => u.state === 'done');
  const busy = uploads.some((u) => u.state === 'uploading');
  const canSend = !sending && !busy && (text.trim().length > 0 || ready.length > 0);

  const submit = useCallback(async () => {
    if (!canSend) return;
    setSending(true);
    setErr(null);
    try {
      await send(convId, text, { parentId, attachmentIds: ready.map((u) => u.att!.id) });
      setText('');
      setUploads([]);
      onSent?.();
      if (draftKey) void client?.call('PUT', `/v1/conversations/${draftKey}/draft`, { text: '' });
    } catch {
      setErr(t('chat.sendFailed'));
    } finally {
      setSending(false);
    }
  }, [canSend, send, convId, text, parentId, ready, onSent, draftKey, client, t]);

  return (
    <div className="composer-wrap">
      {uploads.length > 0 && (
        <div className="uploads">
          {uploads.map((u) => (
            <span key={u.key} className={`att-chip ${u.state}`}>
              <Icon name="file" size={14} /> <span className="ellipsis">{u.name}</span>
              {u.state === 'uploading' && <span className="faint">{t('common.loading')}</span>}
              {u.state === 'error' && <span className="error">{t('common.error')}</span>}
              <button className="btn icon ghost small" aria-label={t('common.remove')} onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}><Icon name="close" size={14} /></button>
            </span>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="mention-menu" role="listbox" aria-label={t('chat.mention')}>
          {suggestions.map((b) => (
            <button key={b.id} role="option" aria-selected="false" className="nav-item" onMouseDown={(e) => { e.preventDefault(); pick(b); }}><BotAvatar bot={b} /> {b.name}</button>
          ))}
        </div>
      )}
      {err && <div role="alert" className="error" style={{ maxWidth: 820, margin: '0 auto 6px' }}>{err}</div>}
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input ref={file} type="file" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" className="btn icon ghost" aria-label={t('chat.attach')} onClick={() => file.current?.click()}><Icon name="attach" /></button>
        <textarea
          ref={area}
          rows={1}
          value={text}
          aria-label={t('chat.placeholder', { name: placeholderName })}
          placeholder={t('chat.placeholder', { name: placeholderName })}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); void addFiles(e.clipboardData.files); } }}
          onKeyDown={(e) => {
            if (suggestions.length && (e.key === 'Enter' || e.key === 'Tab')) {
              e.preventDefault();
              pick(suggestions[0]!);
            } else if (e.key === 'Escape') setMention(null);
            else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button className="send-btn" type="submit" disabled={!canSend} aria-label={t('chat.send')}><Icon name="send" className="flip" /></button>
      </form>
    </div>
  );
}

function toBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
