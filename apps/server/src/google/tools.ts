// Built-in Google tools for Bots (FR-GGL-06): mail (search, read, label, draft, send), calendar
// (read, create), Drive (search, read, upload) and contacts (look up). Each call runs with the
// user's own Google grant; a tool appears only for a service the user granted and while the grant
// is valid. Requests go to Google's REST APIs with the access token in the Authorization header.
import type { Bot, GoogleService, User } from '@advence/protocol';
import type { ToolCtx, ToolProvider } from '../chat/runtime.js';
import type { ModelMessage, ToolCall, ToolSpec } from '../models/types.js';
import { GoogleReconnectNeeded, type GoogleConnections } from './connections.js';

export interface GoogleApiBases {
  gmail: string;
  calendar: string;
  drive: string;
  driveUpload: string;
  people: string;
}

export const GOOGLE_API: GoogleApiBases = {
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  calendar: 'https://www.googleapis.com/calendar/v3',
  drive: 'https://www.googleapis.com/drive/v3',
  driveUpload: 'https://www.googleapis.com/upload/drive/v3',
  people: 'https://people.googleapis.com/v1',
};

const MAX_TEXT = 60_000;
const MAX_UPLOAD = 10 * 1024 * 1024;

class GoogleApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Json = Record<string, any>;
type Def = { service: GoogleService; spec: ToolSpec; run: (u: User, input: Json, signal: AbortSignal) => Promise<string> };

/** One header line: no CR or LF, so a value cannot add headers (header injection). */
function headerValue(v: unknown): string {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 2047 for non-ASCII header text. */
function encodeWord(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function addresses(v: unknown): string {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => headerValue(x)).filter(Boolean);
  for (const a of list) if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|^[^<>]*<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(a)) throw new GoogleApiError(400, `Not an email address: ${a}`);
  return list.join(', ');
}

/** A plain-text RFC 5322 message, base64url for the Gmail API. */
export function mimeMessage(m: { to: unknown; cc?: unknown; subject: unknown; body: unknown; inReplyTo?: string; references?: string }): string {
  const lines = [`To: ${addresses(m.to)}`];
  if (m.cc) lines.push(`Cc: ${addresses(m.cc)}`);
  lines.push(`Subject: ${encodeWord(headerValue(m.subject))}`);
  if (m.inReplyTo) lines.push(`In-Reply-To: ${headerValue(m.inReplyTo)}`);
  if (m.references) lines.push(`References: ${headerValue(m.references)}`);
  lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(String(m.body ?? ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'));
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

function b64text(data: string | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

function stripHtml(h: string): string {
  return h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** The readable text of a Gmail message payload: text/plain first, else HTML without tags. */
function bodyText(p: Json | undefined): string {
  if (!p) return '';
  const all: Json[] = [];
  const walk = (x: Json) => {
    all.push(x);
    for (const c of x.parts ?? []) walk(c);
  };
  walk(p);
  const plain = all.find((x) => x.mimeType === 'text/plain' && x.body?.data);
  if (plain) return b64text(plain.body.data);
  const html = all.find((x) => x.mimeType === 'text/html' && x.body?.data);
  return html ? stripHtml(b64text(html.body.data)) : '';
}

const header = (m: Json, name: string): string => ((m.payload?.headers ?? []) as { name: string; value: string }[]).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** A Drive query from free text; quotes and backslashes escaped (Drive query syntax). */
function driveQuery(text: string): string {
  const esc = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `(name contains '${esc}' or fullText contains '${esc}') and trashed = false`;
}

const obj = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export class GoogleTools implements ToolProvider {
  private defs: Record<string, Def>;

  constructor(private conns: GoogleConnections, private o: { fetch?: typeof fetch; bases?: GoogleApiBases } = {}) {
    this.defs = this.build();
  }

  private get base(): GoogleApiBases {
    return this.o.bases ?? GOOGLE_API;
  }

  /** One API request with the user's token; retried once with a fresh token on 401. */
  private async api(user: User, url: string, init: { method?: string; json?: unknown; body?: Buffer | string; headers?: Record<string, string>; raw?: boolean } = {}, signal?: AbortSignal): Promise<any> {
    const f = this.o.fetch ?? fetch;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.conns.accessToken(user, attempt > 0);
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.headers ?? {}) };
      let body = init.body;
      if (init.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(init.json);
      }
      const r = await f(url, { method: init.method ?? 'GET', headers, body, signal, redirect: 'error' });
      if (r.status === 401 && attempt === 0) continue;
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as Json;
        throw new GoogleApiError(r.status, String(j.error?.message ?? j.error ?? `HTTP ${r.status}`).slice(0, 300));
      }
      if (init.raw) return r;
      return r.status === 204 ? {} : r.json();
    }
    throw new GoogleApiError(401, 'unauthorized');
  }

  private build(): Record<string, Def> {
    const g = (p: string) => `${this.base.gmail}/users/me${p}`;
    const defs: Def[] = [
      {
        service: 'gmail',
        spec: { name: 'google_gmail_search', description: 'Search the user\'s Gmail with Gmail search syntax (from:, subject:, newer_than:2d, is:unread ...). Returns id, date, sender, subject and snippet.', parameters: obj({ query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 50 } }, ['query']) },
        run: async (u, i, s) => {
          const q = new URLSearchParams({ q: String(i.query ?? ''), maxResults: String(Math.min(Number(i.max) || 10, 50)) });
          const list = await this.api(u, g(`/messages?${q}`), {}, s);
          const ids = ((list.messages ?? []) as { id: string }[]).map((m) => m.id);
          if (!ids.length) return 'No messages found.';
          const rows = await Promise.all(ids.map(async (id) => {
            const m = await this.api(u, g(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`), {}, s);
            return `${m.id}\t${header(m, 'Date')}\t${header(m, 'From')}\t${header(m, 'Subject')}\t${(m.snippet ?? '').slice(0, 200)}${(m.labelIds ?? []).includes('UNREAD') ? '\t(unread)' : ''}`;
          }));
          return rows.join('\n');
        },
      },
      {
        service: 'gmail',
        spec: { name: 'google_gmail_read', description: 'Read one Gmail message by id: headers and text body.', parameters: obj({ id: { type: 'string' } }, ['id']) },
        run: async (u, i, s) => {
          const m = await this.api(u, g(`/messages/${encodeURIComponent(String(i.id))}?format=full`), {}, s);
          const head = ['From', 'To', 'Cc', 'Date', 'Subject', 'Message-ID'].map((h) => [h, header(m, h)] as const).filter(([, v]) => v).map(([h, v]) => `${h}: ${v}`);
          return `${head.join('\n')}\nLabels: ${(m.labelIds ?? []).join(', ')}\nThread: ${m.threadId}\n\n${bodyText(m.payload)}`.slice(0, MAX_TEXT);
        },
      },
      {
        service: 'gmail',
        spec: { name: 'google_gmail_label', description: 'Add or remove labels on a Gmail message (names such as "Receipts", or system labels INBOX, UNREAD, STARRED, IMPORTANT). Missing user labels are created. Removing INBOX archives.', parameters: obj({ id: { type: 'string' }, add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, ['id']) },
        run: async (u, i, s) => {
          const labels = ((await this.api(u, g('/labels'), {}, s)).labels ?? []) as { id: string; name: string }[];
          const find = (n: string) => labels.find((l) => l.id === n || l.name.toLowerCase() === n.toLowerCase());
          const add: string[] = [];
          for (const n of (i.add ?? []) as string[]) {
            let l = find(n);
            if (!l) {
              l = (await this.api(u, g('/labels'), { method: 'POST', json: { name: n, labelListVisibility: 'labelShow', messageListVisibility: 'show' } }, s)) as { id: string; name: string };
              labels.push(l);
            }
            add.push(l.id);
          }
          const remove = ((i.remove ?? []) as string[]).map((n) => find(n)?.id).filter((x): x is string => !!x);
          const m = await this.api(u, g(`/messages/${encodeURIComponent(String(i.id))}/modify`), { method: 'POST', json: { addLabelIds: add, removeLabelIds: remove } }, s);
          return `Labels now: ${((m.labelIds ?? []) as string[]).map((id) => labels.find((l) => l.id === id)?.name ?? id).join(', ')}`;
        },
      },
      {
        service: 'gmail',
        spec: { name: 'google_gmail_draft', description: 'Create a Gmail draft (plain text). Give replyTo (a message id) to draft a reply in its thread.', parameters: obj({ to: { type: 'string', description: 'comma-separated addresses' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, replyTo: { type: 'string' } }, ['to', 'subject', 'body']) },
        run: async (u, i, s) => {
          const thread = await this.replyInfo(u, i.replyTo, s);
          const d = await this.api(u, g('/drafts'), { method: 'POST', json: { message: { raw: mimeMessage({ to: i.to, cc: i.cc, subject: i.subject, body: i.body, ...thread.headers }), ...(thread.threadId ? { threadId: thread.threadId } : {}) } } }, s);
          return `Draft saved (id ${d.id}).`;
        },
      },
      {
        service: 'gmail',
        spec: { name: 'google_gmail_send', description: 'Send an email from the user\'s Gmail (plain text). Give replyTo (a message id) to reply in its thread.', parameters: obj({ to: { type: 'string', description: 'comma-separated addresses' }, cc: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, replyTo: { type: 'string' } }, ['to', 'subject', 'body']) },
        run: async (u, i, s) => {
          const thread = await this.replyInfo(u, i.replyTo, s);
          const m = await this.api(u, g('/messages/send'), { method: 'POST', json: { raw: mimeMessage({ to: i.to, cc: i.cc, subject: i.subject, body: i.body, ...thread.headers }), ...(thread.threadId ? { threadId: thread.threadId } : {}) } }, s);
          return `Sent (id ${m.id}).`;
        },
      },
      {
        service: 'calendar',
        spec: { name: 'google_calendar_events', description: 'List events in the user\'s primary Google Calendar between two times (ISO 8601). Defaults to the next 7 days.', parameters: obj({ from: { type: 'string' }, to: { type: 'string' }, query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 100 } }) },
        run: async (u, i, s) => {
          const from = i.from ? new Date(String(i.from)) : new Date();
          const to = i.to ? new Date(String(i.to)) : new Date(from.getTime() + 7 * 86_400_000);
          if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'Invalid date.';
          const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.min(Number(i.max) || 25, 100)) });
          if (i.query) q.set('q', String(i.query));
          const r = await this.api(u, `${this.base.calendar}/calendars/primary/events?${q}`, {}, s);
          const items = (r.items ?? []) as Json[];
          if (!items.length) return 'No events.';
          return items.map((e) => `${e.id}\t${e.start?.dateTime ?? e.start?.date}\t${e.end?.dateTime ?? e.end?.date}\t${e.summary ?? '(no title)'}${e.location ? `\t@ ${e.location}` : ''}${e.attendees?.length ? `\twith ${e.attendees.map((a: Json) => a.email).join(', ')}` : ''}`).join('\n');
        },
      },
      {
        service: 'calendar',
        spec: { name: 'google_calendar_create', description: 'Create an event in the user\'s primary Google Calendar. start and end are ISO 8601 date-times (or YYYY-MM-DD for all-day events). Attendees get Google\'s invitation email.', parameters: obj({ title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, timeZone: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } } }, ['title', 'start', 'end']) },
        run: async (u, i, s) => {
          const when = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? { date: String(v) } : { dateTime: String(v), ...(i.timeZone ? { timeZone: String(i.timeZone) } : {}) });
          const attendees = ((i.attendees ?? []) as string[]).map((a) => ({ email: addresses(a) }));
          const q = attendees.length ? '?sendUpdates=all' : '';
          const e = await this.api(u, `${this.base.calendar}/calendars/primary/events${q}`, { method: 'POST', json: { summary: String(i.title), start: when(i.start), end: when(i.end), ...(i.description ? { description: String(i.description) } : {}), ...(i.location ? { location: String(i.location) } : {}), ...(attendees.length ? { attendees } : {}) } }, s);
          return `Created "${e.summary}" (id ${e.id})${e.htmlLink ? `: ${e.htmlLink}` : ''}`;
        },
      },
      {
        service: 'drive',
        spec: { name: 'google_drive_search', description: 'Search the user\'s Google Drive by name or content. Returns id, name, type and modified time.', parameters: obj({ query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 50 } }, ['query']) },
        run: async (u, i, s) => {
          const q = new URLSearchParams({ q: driveQuery(String(i.query ?? '')), pageSize: String(Math.min(Number(i.max) || 10, 50)), fields: 'files(id,name,mimeType,modifiedTime,webViewLink)' });
          const r = await this.api(u, `${this.base.drive}/files?${q}`, {}, s);
          const files = (r.files ?? []) as Json[];
          return files.length ? files.map((f) => `${f.id}\t${f.name}\t${f.mimeType}\t${f.modifiedTime ?? ''}${f.webViewLink ? `\t${f.webViewLink}` : ''}`).join('\n') : 'No files found.';
        },
      },
      {
        service: 'drive',
        spec: { name: 'google_drive_read', description: 'Read a Google Drive file by id as text (Docs, Sheets as CSV, Slides, and text files).', parameters: obj({ id: { type: 'string' } }, ['id']) },
        run: async (u, i, s) => {
          const id = encodeURIComponent(String(i.id));
          const meta = await this.api(u, `${this.base.drive}/files/${id}?fields=id,name,mimeType,size`, {}, s);
          const exportAs: Record<string, string> = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' };
          let r: Response;
          if (exportAs[meta.mimeType]) r = await this.api(u, `${this.base.drive}/files/${id}/export?mimeType=${encodeURIComponent(exportAs[meta.mimeType]!)}`, { raw: true }, s);
          else if (/^text\/|json|xml|csv|markdown/.test(meta.mimeType)) r = await this.api(u, `${this.base.drive}/files/${id}?alt=media`, { raw: true }, s);
          else return `${meta.name} (${meta.mimeType}, ${meta.size ?? '?'} bytes) is not a text file.`;
          const text = await r.text();
          return `${meta.name}\n\n${text.slice(0, MAX_TEXT)}${text.length > MAX_TEXT ? '\n[truncated]' : ''}`;
        },
      },
      {
        service: 'drive',
        spec: { name: 'google_drive_upload', description: 'Upload a file to the user\'s Google Drive: text content, or base64 for binary files.', parameters: obj({ name: { type: 'string' }, content: { type: 'string' }, contentBase64: { type: 'string' }, mimeType: { type: 'string' }, folderId: { type: 'string' } }, ['name']) },
        run: async (u, i, s) => {
          const data = i.contentBase64 ? Buffer.from(String(i.contentBase64), 'base64') : Buffer.from(String(i.content ?? ''), 'utf8');
          if (data.length > MAX_UPLOAD) return 'The file is larger than 10 MB.';
          const mime = /^[\w.+-]+\/[\w.+-]+$/.test(String(i.mimeType ?? '')) ? String(i.mimeType) : i.contentBase64 ? 'application/octet-stream' : 'text/plain';
          const boundary = `advence-${Math.random().toString(36).slice(2)}`;
          const metadata = { name: String(i.name).slice(0, 500), ...(i.folderId ? { parents: [String(i.folderId)] } : {}) };
          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
            data,
            Buffer.from(`\r\n--${boundary}--`),
          ]);
          const f = await this.api(u, `${this.base.driveUpload}/files?uploadType=multipart&fields=id,name,webViewLink`, { method: 'POST', body, headers: { 'content-type': `multipart/related; boundary=${boundary}` } }, s);
          return `Uploaded ${f.name} (id ${f.id})${f.webViewLink ? `: ${f.webViewLink}` : ''}`;
        },
      },
      {
        service: 'contacts',
        spec: { name: 'google_contacts_search', description: 'Look up the user\'s Google Contacts by name, email or phone.', parameters: obj({ query: { type: 'string' } }, ['query']) },
        run: async (u, i, s) => {
          const q = new URLSearchParams({ query: String(i.query ?? ''), readMask: 'names,emailAddresses,phoneNumbers,organizations', pageSize: '20' });
          const r = await this.api(u, `${this.base.people}/people:searchContacts?${q}`, {}, s);
          const people = ((r.results ?? []) as Json[]).map((x) => x.person as Json);
          if (!people.length) return 'No contacts found.';
          return people.map((p) => [p.names?.[0]?.displayName ?? '(no name)', ...(p.emailAddresses ?? []).map((e: Json) => e.value), ...(p.phoneNumbers ?? []).map((e: Json) => e.value), p.organizations?.[0]?.name].filter(Boolean).join('\t')).join('\n');
        },
      },
    ];
    return Object.fromEntries(defs.map((d) => [d.spec.name, d]));
  }

  private async replyInfo(u: User, id: unknown, s: AbortSignal): Promise<{ threadId?: string; headers: { inReplyTo?: string; references?: string } }> {
    if (!id) return { headers: {} };
    const m = await this.api(u, `${this.base.gmail}/users/me/messages/${encodeURIComponent(String(id))}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`, {}, s);
    const mid = header(m, 'Message-ID');
    return { threadId: m.threadId, headers: mid ? { inReplyTo: mid, references: `${header(m, 'References')} ${mid}`.trim() } : {} };
  }

  specs(user: User, _bot: Bot): ToolSpec[] {
    const usable = this.conns.usable(user);
    return Object.values(this.defs).filter((d) => usable.includes(d.service)).map((d) => d.spec);
  }

  handles(name: string): boolean {
    return name in this.defs;
  }

  system(user: User, _bot: Bot): string | null {
    const c = this.conns.get(user);
    if (c.state === 'none') return null;
    if (c.state === 'reconnect') return 'The user\'s Google connection has expired. Google tools are unavailable until the user reconnects Google in Settings; say so if a task needs mail, calendar, Drive or contacts.';
    return `You can use the user's Google account (${c.email}): ${c.services.join(', ')}. Send mail, create events with attendees or upload files only when the user asked for it or a routine says so.`;
  }

  async run(c: ToolCtx, call: ToolCall): Promise<ModelMessage> {
    const d = this.defs[call.name]!;
    const fail = (content: string): ModelMessage => ({ role: 'tool', toolCallId: call.id, content, isError: true });
    if (!this.conns.usable(c.user).includes(d.service)) return fail('This Google service is not connected. Ask the user to connect Google in Settings.');
    try {
      const out = await d.run(c.user, (call.input ?? {}) as Json, c.signal);
      return { role: 'tool', toolCallId: call.id, content: out };
    } catch (e) {
      if (e instanceof GoogleReconnectNeeded) return fail('The Google connection has expired. Ask the user to reconnect Google in Settings.');
      if (e instanceof GoogleApiError) return fail(`Google answered ${e.status}: ${e.message}`);
      if (c.signal.aborted) return fail('Stopped.');
      return fail(`The Google request failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }
}
