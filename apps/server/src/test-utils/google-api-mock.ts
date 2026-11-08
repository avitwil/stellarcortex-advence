// A stand-in for the Gmail, Calendar, Drive and People REST APIs (FR-GGL-06 tests): an in-memory
// test account with mail, labels, events, files and contacts, and a log of every request.
import http from 'node:http';
import type { GoogleApiBases } from '../google/tools.js';

export interface ApiRequest { method: string; path: string; query: URLSearchParams; auth: string | null; body: string; contentType: string }

export interface GoogleApiMock {
  url: string;
  bases: GoogleApiBases;
  requests: ApiRequest[];
  /** tokens the APIs accept */
  validTokens: Set<string>;
  messages: { id: string; threadId: string; from: string; to: string; subject: string; date: string; body: string; html?: boolean; labelIds: string[] }[];
  labels: { id: string; name: string; type: 'system' | 'user' }[];
  drafts: { id: string; raw: string; threadId?: string }[];
  sent: { id: string; raw: string; threadId?: string }[];
  events: { id: string; summary: string; start: Record<string, string>; end: Record<string, string>; attendees?: { email: string }[]; location?: string; description?: string }[];
  files: { id: string; name: string; mimeType: string; content: string; modifiedTime: string; parents?: string[] }[];
  contacts: { name: string; email: string; phone?: string }[];
  close(): Promise<void>;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export async function startGoogleApiMock(): Promise<GoogleApiMock> {
  let n = 100;
  const m: GoogleApiMock = {
    url: '',
    bases: { gmail: '', calendar: '', drive: '', driveUpload: '', people: '' },
    requests: [],
    validTokens: new Set(['ya29.test-access-token', 'ya29.refreshed-access-token']),
    messages: [
      { id: 'm1', threadId: 't1', from: 'Dana <dana@example.com>', to: 'owner@example.com', subject: 'Invoice for October', date: 'Mon, 2 Nov 2026 09:00:00 +0200', body: 'Hi, the invoice for October is attached. Total 1,200 ILS.', labelIds: ['INBOX', 'UNREAD'] },
      { id: 'm2', threadId: 't2', from: 'School <office@school.example>', to: 'owner@example.com', subject: 'Trip on Thursday', date: 'Tue, 3 Nov 2026 10:00:00 +0200', body: '<p>The class trip leaves at <b>08:00</b>.</p>', html: true, labelIds: ['INBOX'] },
    ],
    labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'UNREAD', name: 'UNREAD', type: 'system' },
      { id: 'STARRED', name: 'STARRED', type: 'system' },
      { id: 'Label_1', name: 'Receipts', type: 'user' },
    ],
    drafts: [],
    sent: [],
    events: [{ id: 'e1', summary: 'Dentist', start: { dateTime: '2026-11-10T09:00:00+02:00' }, end: { dateTime: '2026-11-10T09:30:00+02:00' }, location: 'Herzl 5' }],
    files: [
      { id: 'f1', name: 'Budget 2026', mimeType: 'application/vnd.google-apps.spreadsheet', content: 'Month,Groceries\nJan,2500\n', modifiedTime: '2026-10-01T10:00:00Z' },
      { id: 'f2', name: 'Trip notes.txt', mimeType: 'text/plain', content: 'Pack sunscreen and water.', modifiedTime: '2026-10-02T10:00:00Z' },
      { id: 'f3', name: 'photo.jpg', mimeType: 'image/jpeg', content: 'JPEG', modifiedTime: '2026-10-03T10:00:00Z' },
    ],
    contacts: [
      { name: 'Dana Levi', email: 'dana@example.com', phone: '+972-50-000-0001' },
      { name: 'Yossi Cohen', email: 'yossi@example.com' },
    ],
    close: async () => undefined,
  };

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const headersOf = (x: GoogleApiMock['messages'][number]) => [
    { name: 'From', value: x.from },
    { name: 'To', value: x.to },
    { name: 'Subject', value: x.subject },
    { name: 'Date', value: x.date },
    { name: 'Message-ID', value: `<${x.id}@mail.example>` },
  ];

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const buf = Buffer.concat(chunks);
    const body = buf.toString('utf8');
    const bin = buf.toString('latin1');
    const u = new URL(req.url ?? '/', 'http://x');
    const r: ApiRequest = { method: req.method ?? '', path: u.pathname, query: u.searchParams, auth: req.headers.authorization ?? null, body, contentType: String(req.headers['content-type'] ?? '') };
    m.requests.push(r);
    const tok = /^Bearer (.+)$/.exec(r.auth ?? '')?.[1];
    if (!tok || !m.validTokens.has(tok)) return json(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });
    const p = u.pathname;
    let mm: RegExpExecArray | null;

    // ---- Gmail
    if (p === '/gmail/v1/users/me/messages' && req.method === 'GET') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const words = q.split(/\s+/).filter((w) => w && !w.includes(':'));
      const unread = q.includes('is:unread');
      const hits = m.messages.filter((x) => (!unread || x.labelIds.includes('UNREAD')) && words.every((w) => `${x.from} ${x.subject} ${x.body}`.toLowerCase().includes(w)));
      return json(res, 200, { messages: hits.slice(0, Number(u.searchParams.get('maxResults') ?? 100)).map((x) => ({ id: x.id, threadId: x.threadId })), resultSizeEstimate: hits.length });
    }
    if ((mm = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const x = m.messages.find((y) => y.id === mm![1]);
      if (!x) return json(res, 404, { error: { code: 404, message: 'Not Found' } });
      const fmt = u.searchParams.get('format');
      const payload = fmt === 'full'
        ? { mimeType: 'multipart/alternative', headers: headersOf(x), parts: [{ mimeType: x.html ? 'text/html' : 'text/plain', body: { data: b64(x.body) } }] }
        : { headers: headersOf(x).filter((h) => u.searchParams.getAll('metadataHeaders').map((s) => s.toLowerCase()).includes(h.name.toLowerCase())) };
      return json(res, 200, { id: x.id, threadId: x.threadId, labelIds: x.labelIds, snippet: x.body.replace(/<[^>]+>/g, '').slice(0, 80), payload });
    }
    if ((mm = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/.exec(p)) && req.method === 'POST') {
      const x = m.messages.find((y) => y.id === mm![1]);
      if (!x) return json(res, 404, { error: { code: 404, message: 'Not Found' } });
      const b = JSON.parse(body) as { addLabelIds?: string[]; removeLabelIds?: string[] };
      for (const id of b.addLabelIds ?? []) if (!x.labelIds.includes(id)) x.labelIds.push(id);
      x.labelIds = x.labelIds.filter((id) => !(b.removeLabelIds ?? []).includes(id));
      return json(res, 200, { id: x.id, threadId: x.threadId, labelIds: x.labelIds });
    }
    if (p === '/gmail/v1/users/me/labels' && req.method === 'GET') return json(res, 200, { labels: m.labels });
    if (p === '/gmail/v1/users/me/labels' && req.method === 'POST') {
      const b = JSON.parse(body) as { name: string };
      const l = { id: `Label_${++n}`, name: b.name, type: 'user' as const };
      m.labels.push(l);
      return json(res, 200, l);
    }
    if (p === '/gmail/v1/users/me/drafts' && req.method === 'POST') {
      const b = JSON.parse(body) as { message: { raw: string; threadId?: string } };
      const d = { id: `d${++n}`, raw: b.message.raw, threadId: b.message.threadId };
      m.drafts.push(d);
      return json(res, 200, { id: d.id, message: { id: `m${n}`, threadId: d.threadId ?? `t${n}` } });
    }
    if (p === '/gmail/v1/users/me/messages/send' && req.method === 'POST') {
      const b = JSON.parse(body) as { raw: string; threadId?: string };
      const s = { id: `s${++n}`, raw: b.raw, threadId: b.threadId };
      m.sent.push(s);
      return json(res, 200, { id: s.id, threadId: s.threadId ?? `t${n}`, labelIds: ['SENT'] });
    }

    // ---- Calendar
    if (p === '/calendar/v3/calendars/primary/events' && req.method === 'GET') {
      const min = Date.parse(u.searchParams.get('timeMin') ?? '1970-01-01');
      const max = Date.parse(u.searchParams.get('timeMax') ?? '2999-01-01');
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const items = m.events.filter((e) => {
        const t = Date.parse(e.start.dateTime ?? e.start.date!);
        return t >= min && t < max && (!q || e.summary.toLowerCase().includes(q));
      });
      return json(res, 200, { items });
    }
    if (p === '/calendar/v3/calendars/primary/events' && req.method === 'POST') {
      const b = JSON.parse(body) as GoogleApiMock['events'][number];
      const e = { ...b, id: `e${++n}` };
      m.events.push(e);
      return json(res, 200, { ...e, htmlLink: `https://calendar.example/event?eid=${e.id}` });
    }

    // ---- Drive
    if (p === '/drive/v3/files' && req.method === 'GET') {
      const q = u.searchParams.get('q') ?? '';
      const term = /name contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1').toLowerCase() ?? '';
      const files = m.files.filter((f) => f.name.toLowerCase().includes(term) || f.content.toLowerCase().includes(term));
      return json(res, 200, { files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, webViewLink: `https://drive.example/${f.id}` })) });
    }
    if ((mm = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(p))) {
      const f = m.files.find((x) => x.id === mm![1]);
      if (!f) return json(res, 404, { error: { code: 404, message: 'File not found' } });
      res.writeHead(200, { 'content-type': u.searchParams.get('mimeType') ?? 'text/plain' });
      return res.end(f.content);
    }
    if ((mm = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
      const f = m.files.find((x) => x.id === mm![1]);
      if (!f) return json(res, 404, { error: { code: 404, message: 'File not found' } });
      if (u.searchParams.get('alt') === 'media') {
        res.writeHead(200, { 'content-type': f.mimeType });
        return res.end(f.content);
      }
      return json(res, 200, { id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.content.length) });
    }
    if (p === '/upload/drive/v3/files' && req.method === 'POST' && u.searchParams.get('uploadType') === 'multipart') {
      const boundary = /boundary=([^;]+)/.exec(r.contentType)?.[1];
      if (!boundary) return json(res, 400, { error: { code: 400, message: 'no boundary' } });
      const parts = bin.split(`--${boundary}`).slice(1, -1).map((x) => x.replace(/^\r\n/, '').replace(/\r\n$/, ''));
      const [metaPart, dataPart] = parts;
      const meta = JSON.parse(Buffer.from(metaPart!.split('\r\n\r\n')[1]!, 'latin1').toString('utf8')) as { name: string; parents?: string[] };
      const mime = /Content-Type: ([^\r\n]+)/.exec(dataPart!)?.[1] ?? 'application/octet-stream';
      const content = Buffer.from(dataPart!.slice(dataPart!.indexOf('\r\n\r\n') + 4), 'latin1').toString('utf8');
      const f = { id: `f${++n}`, name: meta.name, mimeType: mime, content, modifiedTime: new Date().toISOString(), parents: meta.parents };
      m.files.push(f);
      return json(res, 200, { id: f.id, name: f.name, webViewLink: `https://drive.example/${f.id}` });
    }

    // ---- People
    if (p === '/v1/people:searchContacts') {
      const q = (u.searchParams.get('query') ?? '').toLowerCase();
      const results = q ? m.contacts.filter((c) => `${c.name} ${c.email} ${c.phone ?? ''}`.toLowerCase().includes(q)) : [];
      return json(res, 200, { results: results.map((c) => ({ person: { names: [{ displayName: c.name }], emailAddresses: [{ value: c.email }], ...(c.phone ? { phoneNumbers: [{ value: c.phone }] } : {}) } })) });
    }
    json(res, 404, { error: { code: 404, message: `no route ${req.method} ${p}` } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  m.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  m.bases = { gmail: `${m.url}/gmail/v1`, calendar: `${m.url}/calendar/v3`, drive: `${m.url}/drive/v3`, driveUpload: `${m.url}/upload/drive/v3`, people: `${m.url}/v1` };
  m.close = () => {
    server.closeAllConnections();
    return new Promise((r) => server.close(() => r()));
  };
  return m;
}
