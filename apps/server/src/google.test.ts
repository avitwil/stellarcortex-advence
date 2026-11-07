// P5 Google services (FR-GGL-04..06): one consent for Gmail, Calendar, Drive and Contacts, the
// Testing-mode 7-day expiry, and the Bots' Google tools against a stand-in for Google's APIs.
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Bot, GoogleConnection, User } from '@advence/protocol';
import { startTestServer, ownerClient, pairedClient, type TestClient, type TestEnv } from './test-utils/harness.js';
import { startGoogleApiMock, type GoogleApiMock } from './test-utils/google-api-mock.js';
import { MockModels, type SeenRequest, type Turn } from './test-utils/mock-models.js';
import { CONNECT_SCOPES, DAY, SERVICE_SCOPES } from './google/connections.js';
import { mimeMessage } from './google/tools.js';
import type { ToolCall } from './models/types.js';

let env: TestEnv;
let api: GoogleApiMock;
let models: MockModels;
let owner: TestClient;
let user: User;
let bot: Bot;
const ALL = CONNECT_SCOPES.join(' ');
const cid = () => `c-${Math.random().toString(36).slice(2, 12)}`;
let chatPlan: (r: SeenRequest) => Turn = () => ({ text: ['OK.'] });

async function req(c: TestClient, method: string, url: string, body?: unknown): Promise<any> {
  const r = await c.request(method, url, body);
  expect(r.status, `${method} ${url} ${JSON.stringify(r.json)}`).toBe(200);
  return r.json;
}

/** The whole consent: start, the user approves on Google, the app returns the code. */
async function connect(c: TestClient, sub: string, email: string, granted = ALL): Promise<GoogleConnection> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const s = await req(c, 'POST', '/v1/google/connect/start', { redirectUri: 'http://localhost:47823/oauth/callback', codeChallenge: challenge });
  env.google.grantedScope = granted;
  const code = await env.google.issueCode({ sub, email });
  return req(c, 'POST', '/v1/google/connect/finish', { code, state: s.state, codeVerifier: verifier });
}

const conns = () => env.server.google.connections;
const tools = () => env.server.google.tools;
const names = () => tools().specs(user, bot).map((s) => s.name);

async function tool(name: string, input: unknown): Promise<{ content: string; isError?: boolean }> {
  const call: ToolCall = { id: `t${Math.random()}`, name, input };
  return (await tools().run({ user, bot, convId: 'conv', messageId: 'm', signal: AbortSignal.timeout(20_000) }, call)) as never;
}

beforeAll(async () => {
  api = await startGoogleApiMock();
  models = await MockModels.start();
  models.script = (r) => chatPlan(r);
  env = await startTestServer({ boot: { googleApiBases: api.bases, modelFetch: models.fetch } });
  owner = await ownerClient(env);
  const uid = (env.server.ctx.db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id;
  user = env.server.ctx.identity.getUser(uid)!;
  const src = (await req(owner, 'POST', '/v1/sources', { kind: 'openai', name: 'OpenAI', apiKey: 'sk-test-google' })).id;
  const b = await req(owner, 'POST', '/v1/bots', { name: 'Helper', sourceId: src });
  bot = env.server.chat.bots.get(b.id)!;
});
afterAll(async () => {
  await env?.close();
  await api?.close();
  await models?.close();
});

describe('FR-GGL-04 one consent connects Gmail, Calendar, Drive and Contacts', () => {
  it('asks for all four services with offline access, PKCE and consent, in one authorization request', async () => {
    expect((await req(owner, 'GET', '/v1/google')).state).toBe('none');
    const s = await req(owner, 'POST', '/v1/google/connect/start', { redirectUri: 'http://localhost:47823/oauth/callback', codeChallenge: 'x'.repeat(43) });
    const u = new URL(s.url);
    const scopes = u.searchParams.get('scope')!.split(' ');
    for (const sc of [...SERVICE_SCOPES.gmail, ...SERVICE_SCOPES.calendar, ...SERVICE_SCOPES.drive, ...SERVICE_SCOPES.contacts]) expect(scopes).toContain(sc);
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('login_hint')).toBe('owner@example.com');
    expect(u.searchParams.get('state')).toBe(s.state);
    // Only the loopback redirect is accepted.
    expect((await owner.request('POST', '/v1/google/connect/start', { redirectUri: 'https://evil.example/cb', codeChallenge: 'x'.repeat(43) })).status).toBe(400);
  });

  it('stores the refresh token sealed and makes all four connectors usable after one consent', async () => {
    const c = await connect(owner, 'owner-sub', 'owner@example.com');
    expect(c.state).toBe('ok');
    expect(c.services.sort()).toEqual(['calendar', 'contacts', 'drive', 'gmail']);
    expect(c.missing).toEqual([]);
    expect(c.email).toBe('owner@example.com');
    expect(c.expiresAt! - c.connectedAt!).toBe(7 * DAY);
    expect(env.google.lastTokenRequest!.get('code_verifier')).toBeTruthy();
    const row = env.server.ctx.db.prepare('SELECT body FROM google_connections WHERE user_id = ?').get(user.id) as { body: Buffer };
    expect(row.body.toString('latin1')).not.toMatch(/1\/\/test-refresh-token|ya29\./);
    expect(JSON.stringify(c)).not.toMatch(/1\/\/test-refresh-token|ya29\./);
    expect(names()).toEqual(expect.arrayContaining(['google_gmail_search', 'google_calendar_events', 'google_drive_search', 'google_contacts_search']));
    // One check per connector, right after the consent.
    expect((await tool('google_gmail_search', { query: 'invoice' })).content).toContain('Invoice for October');
    expect((await tool('google_calendar_events', { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' })).content).toContain('Dentist');
    expect((await tool('google_drive_search', { query: 'budget' })).content).toContain('Budget 2026');
    expect((await tool('google_contacts_search', { query: 'dana' })).content).toContain('dana@example.com');
  });

  it('a state from another device or a wrong verifier is refused', async () => {
    const other = await pairedClient(env, { approveAs: owner });
    expect((await other.loginWithCode(env.google, { sub: 'owner-sub', email: 'owner@example.com' })).status).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const s = await req(owner, 'POST', '/v1/google/connect/start', { redirectUri: 'http://localhost:47823/oauth/callback', codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
    const code = await env.google.issueCode({ sub: 'owner-sub', email: 'owner@example.com' });
    expect((await other.request('POST', '/v1/google/connect/finish', { code, state: s.state, codeVerifier: verifier })).json.error).toBe('invalid_state');
    const s2 = await req(owner, 'POST', '/v1/google/connect/start', { redirectUri: 'http://localhost:47823/oauth/callback', codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
    expect((await owner.request('POST', '/v1/google/connect/finish', { code, state: s2.state, codeVerifier: randomBytes(32).toString('base64url') })).json.error).toBe('pkce_mismatch');
  });

  it('a partial consent connects only the granted services', async () => {
    await connect(owner, 'owner-sub', 'owner@example.com', ['openid', 'email', ...SERVICE_SCOPES.gmail, ...SERVICE_SCOPES.calendar].join(' '));
    const c = await req(owner, 'GET', '/v1/google');
    expect(c.services.sort()).toEqual(['calendar', 'gmail']);
    expect(c.missing.sort()).toEqual(['contacts', 'drive']);
    expect(names()).not.toContain('google_drive_search');
    expect((await tool('google_drive_search', { query: 'x' })).isError).toBe(true);
    // The replaced grant was revoked at Google.
    expect(env.google.revoked.length).toBeGreaterThan(0);
    await connect(owner, 'owner-sub', 'owner@example.com');
  });

  it('Android: a server auth code from Google\'s authorization client is exchanged without a redirect URI', async () => {
    const info = await req(owner, 'GET', '/v1/google/connect');
    expect(info.scopes).toEqual(CONNECT_SCOPES);
    env.google.grantedScope = ALL;
    const code = await env.google.issueCode({ sub: 'owner-sub', email: 'owner@example.com' });
    const c = await req(owner, 'POST', '/v1/google/connect/finish', { serverAuthCode: code });
    expect(c.state).toBe('ok');
    expect(env.google.lastTokenRequest!.get('redirect_uri')).toBe('');
    expect(env.google.lastTokenRequest!.has('code_verifier')).toBe(false);
  });

  it('each user connects their own account', async () => {
    expect((await owner.request('POST', '/v1/allowlist', { email: 'kid@example.com' })).status).toBe(200);
    const kid = await pairedClient(env, { approveAs: owner });
    expect((await kid.loginWithCode(env.google, { sub: 'kid-sub', email: 'kid@example.com' })).status).toBe(200);
    expect((await req(kid, 'GET', '/v1/google')).state).toBe('none');
    const c = await connect(kid, 'kid-sub', 'kid@example.com');
    expect(c.email).toBe('kid@example.com');
    expect((await req(owner, 'GET', '/v1/google')).email).toBe('owner@example.com');
    const d = await req(kid, 'DELETE', '/v1/google');
    expect(d.state).toBe('none');
    expect((await req(owner, 'GET', '/v1/google')).state).toBe('ok');
  });
});

describe('FR-GGL-05 7-day expiry in Testing mode', () => {
  it('reminds on day 6 with a one-tap reconnect, shows "reconnect" after day 7 and recovers with a new consent', async () => {
    const real = Date.now;
    const start = Date.now();
    const events: { event: string; data: any }[] = [];
    const off = env.server.ctx.bus.subscribe((e) => {
      if (e.userId === user.id && e.event === 'google.connection') events.push({ event: e.event, data: e.data });
    });
    try {
      await connect(owner, 'owner-sub', 'owner@example.com');
      conns().now = () => start + 5 * DAY;
      await conns().tick();
      expect((await req(owner, 'GET', '/v1/google')).state).toBe('ok');
      expect(events.filter((e) => e.data.reminder)).toHaveLength(0);

      conns().now = () => start + 6 * DAY + 60_000;
      await conns().tick();
      await conns().tick();
      const reminders = events.filter((e) => e.data.reminder);
      expect(reminders).toHaveLength(1);
      expect(reminders[0]!.data.state).toBe('expiring');
      expect((await req(owner, 'GET', '/v1/google')).state).toBe('expiring');
      // Still usable while expiring.
      expect(names()).toContain('google_gmail_search');

      conns().now = () => start + 7 * DAY + 60_000;
      await conns().tick();
      expect((await req(owner, 'GET', '/v1/google')).state).toBe('reconnect');
      expect(events.at(-1)!.data.state).toBe('reconnect');
      // Degrades gracefully: no Google tools, and the Bot is told why.
      expect(names().filter((n) => n.startsWith('google_'))).toEqual([]);
      expect(tools().system(user, bot)).toMatch(/reconnect/i);
      expect((await tool('google_gmail_search', { query: 'x' })).content).toMatch(/connect/i);

      // One tap: the same consent again.
      conns().now = () => start + 7 * DAY + 120_000;
      const c = await connect(owner, 'owner-sub', 'owner@example.com');
      expect(c.state).toBe('ok');
      expect(c.expiresAt).toBe(start + 14 * DAY + 120_000);
      expect(names()).toContain('google_gmail_search');
    } finally {
      off();
      conns().now = real;
    }
  });

  it('a refresh token Google no longer honours turns the connection to "reconnect" at once', async () => {
    await connect(owner, 'owner-sub', 'owner@example.com');
    api.validTokens.delete('ya29.test-access-token');
    env.google.refreshError = 'invalid_grant';
    try {
      const r = await tool('google_gmail_search', { query: 'invoice' });
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/reconnect/i);
      expect((await req(owner, 'GET', '/v1/google')).state).toBe('reconnect');
    } finally {
      env.google.refreshError = undefined;
      api.validTokens.add('ya29.test-access-token');
      await connect(owner, 'owner-sub', 'owner@example.com');
    }
  });

  it('an expired access token is refreshed and the call retried', async () => {
    api.validTokens.delete('ya29.test-access-token');
    const before = env.google.refreshes;
    try {
      const r = await tool('google_gmail_search', { query: 'invoice' });
      expect(r.isError).toBeFalsy();
      expect(env.google.refreshes).toBe(before + 1);
      expect(api.requests.at(-1)!.auth).toBe('Bearer ya29.refreshed-access-token');
    } finally {
      api.validTokens.add('ya29.test-access-token');
    }
  });
});

describe('FR-GGL-06 Google tools for Bots', () => {
  beforeAll(async () => {
    await connect(owner, 'owner-sub', 'owner@example.com');
  });

  it('mail: search, read, label, draft and send', async () => {
    const s = await tool('google_gmail_search', { query: 'is:unread invoice' });
    expect(s.content).toMatch(/^m1\t.*Dana.*Invoice for October.*\(unread\)$/m);
    const r = await tool('google_gmail_read', { id: 'm2' });
    expect(r.content).toContain('Subject: Trip on Thursday');
    expect(r.content).toContain('The class trip leaves at 08:00.');
    const l = await tool('google_gmail_label', { id: 'm1', add: ['Receipts', 'Bills 2026'], remove: ['UNREAD', 'INBOX'] });
    expect(l.content).toContain('Receipts');
    expect(l.content).toContain('Bills 2026');
    expect(api.messages.find((m) => m.id === 'm1')!.labelIds).not.toContain('INBOX');
    expect(api.labels.some((x) => x.name === 'Bills 2026')).toBe(true);

    const d = await tool('google_gmail_draft', { to: 'dana@example.com', subject: 'Re: Invoice', body: 'Thanks, paid.', replyTo: 'm1' });
    expect(d.content).toMatch(/^Draft saved/);
    const draft = Buffer.from(api.drafts.at(-1)!.raw, 'base64url').toString('utf8');
    expect(draft).toMatch(/^To: dana@example.com\r\n/);
    expect(draft).toContain('In-Reply-To: <m1@mail.example>');
    expect(api.drafts.at(-1)!.threadId).toBe('t1');

    const sent = await tool('google_gmail_send', { to: 'yossi@example.com', subject: 'שלום Yossi', body: 'See you tomorrow.' });
    expect(sent.content).toMatch(/^Sent/);
    const raw = Buffer.from(api.sent.at(-1)!.raw, 'base64url').toString('utf8');
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(Buffer.from(raw.split('\r\n\r\n')[1]!, 'base64').toString('utf8')).toBe('See you tomorrow.');
  });

  it('mail: header injection through the subject or a recipient is impossible', async () => {
    const raw = Buffer.from(mimeMessage({ to: 'a@example.com', subject: 'Hi\r\nBcc: victim@example.com', body: 'x' }), 'base64url').toString('utf8');
    expect(raw.split('\r\n\r\n')[0]).not.toMatch(/^Bcc:/m);
    const bad = await tool('google_gmail_send', { to: 'a@example.com\r\nBcc: victim@example.com', subject: 'x', body: 'y' });
    expect(bad.isError).toBe(true);
    expect(api.sent.some((s) => Buffer.from(s.raw, 'base64url').toString('utf8').includes('victim@'))).toBe(false);
  });

  it('calendar: read and create events', async () => {
    const list = await tool('google_calendar_events', { from: '2026-11-09T00:00:00Z', to: '2026-11-11T00:00:00Z' });
    expect(list.content).toMatch(/^e1\t2026-11-10T09:00:00\+02:00\t.*Dentist\t@ Herzl 5$/m);
    const c = await tool('google_calendar_create', { title: 'Parent meeting', start: '2026-11-12T18:00:00', end: '2026-11-12T19:00:00', timeZone: 'Asia/Jerusalem', attendees: ['dana@example.com'] });
    expect(c.content).toMatch(/^Created "Parent meeting"/);
    const e = api.events.at(-1)!;
    expect(e.start).toEqual({ dateTime: '2026-11-12T18:00:00', timeZone: 'Asia/Jerusalem' });
    expect(e.attendees).toEqual([{ email: 'dana@example.com' }]);
    expect(api.requests.at(-1)!.query.get('sendUpdates')).toBe('all');
    const allDay = await tool('google_calendar_create', { title: 'Holiday', start: '2026-12-25', end: '2026-12-26' });
    expect(allDay.isError).toBeFalsy();
    expect(api.events.at(-1)!.start).toEqual({ date: '2026-12-25' });
  });

  it('drive: search, read and upload files', async () => {
    await tool('google_drive_search', { query: "budget's" });
    expect(api.requests.at(-1)!.query.get('q')).toContain("budget\\'s");
    const s2 = await tool('google_drive_search', { query: 'trip' });
    expect(s2.content).toContain('f2\tTrip notes.txt\ttext/plain');
    expect((await tool('google_drive_read', { id: 'f1' })).content).toBe('Budget 2026\n\nMonth,Groceries\nJan,2500\n');
    expect(api.requests.at(-1)!.path).toBe('/drive/v3/files/f1/export');
    expect((await tool('google_drive_read', { id: 'f2' })).content).toContain('Pack sunscreen');
    expect((await tool('google_drive_read', { id: 'f3' })).content).toMatch(/not a text file/);
    const up = await tool('google_drive_upload', { name: 'סיכום.md', content: '# Summary\nשלום', mimeType: 'text/markdown' });
    expect(up.content).toMatch(/^Uploaded סיכום\.md/);
    const f = api.files.at(-1)!;
    expect(f.mimeType).toBe('text/markdown');
    expect(f.content).toBe('# Summary\nשלום');
    const bin = await tool('google_drive_upload', { name: 'b.bin', contentBase64: Buffer.from([1, 2, 3]).toString('base64') });
    expect(bin.isError).toBeFalsy();
    expect(api.files.at(-1)!.mimeType).toBe('application/octet-stream');
  });

  it('contacts: look up by name, email or phone', async () => {
    expect((await tool('google_contacts_search', { query: 'levi' })).content).toBe('Dana Levi\tdana@example.com\t+972-50-000-0001');
    expect((await tool('google_contacts_search', { query: 'nobody' })).content).toBe('No contacts found.');
  });

  it('a Bot uses a Google tool from chat, with the token only in the Authorization header', async () => {
    chatPlan = (r) => {
      const results = (r.body.messages as any[]).filter((m) => m.role === 'tool');
      if (!results.length) return { tool: { name: 'google_contacts_search', input: { query: 'yossi' } } };
      return { text: [`Found: ${results[0].content}`] };
    };
    const conv = (await req(owner, 'POST', '/v1/conversations/direct', { botId: bot.id })).id;
    await req(owner, 'POST', `/v1/conversations/${conv}/messages`, { text: "what's Yossi's email?", clientId: cid() });
    await env.server.chat.runtime.idle();
    const list = await req(owner, 'GET', `/v1/conversations/${conv}/messages`);
    expect(list.at(-1).text).toContain('yossi@example.com');
    const first = models.requests.find((r) => String(JSON.stringify(r.body.messages)).includes("Yossi's email"));
    expect(String(first!.body.messages[0].content)).toContain('Google account (owner@example.com)');
    for (const r of api.requests) {
      expect(r.query.toString()).not.toMatch(/ya29|access_token/);
      expect(r.auth).toMatch(/^Bearer ya29\./);
    }
    // Tokens never reach the model either.
    expect(JSON.stringify(models.requests)).not.toMatch(/ya29\.|1\/\/test-refresh/);
  });
});
