// MCP test servers (P5): the reference "everything" server over Streamable HTTP, a 2025-only
// server, and an OAuth-protected server with its own minimal authorization server (RFC 9728,
// RFC 8414, RFC 8707, RFC 9207, PKCE, dynamic registration and Client ID Metadata Documents).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { createMcpHandler, legacyStatelessFallback, McpServer } from '@modelcontextprotocol/server';

const require = createRequire(import.meta.url);

export function everythingEntry(): string {
  const pkg = require.resolve('@modelcontextprotocol/server-everything/package.json');
  return path.join(path.dirname(fs.realpathSync(pkg)), 'dist', 'index.js');
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export interface Running { url: string; close(): Promise<void> }

export async function startEverythingHttp(): Promise<Running> {
  const port = await freePort();
  const p: ChildProcess = spawn(process.execPath, [everythingEntry(), 'streamableHttp'], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('everything server did not start')), 20_000);
    const on = (d: Buffer) => {
      if (/listening|running/i.test(d.toString())) {
        clearTimeout(t);
        resolve();
      }
    };
    p.stderr!.on('data', on);
    p.stdout!.on('data', on);
    p.on('exit', (c) => reject(new Error(`everything server exited ${c}`)));
  });
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      p.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

async function serve(handler: (req: Request) => Promise<Response>, onRaw?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(async (req, res) => {
    if (onRaw?.(req, res)) return;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const body = chunks.length && req.method !== 'GET' ? Buffer.concat(chunks) : undefined;
    const r = await handler(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body }));
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    if (r.body) Readable.fromWeb(r.body as never).pipe(res);
    else res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` };
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((r) => server.close(() => r()));
}

/** A server that only speaks the 2025-11-25 protocol (no server/discover). */
export async function startLegacyMcp(): Promise<Running> {
  const h = legacyStatelessFallback(() => {
    const s = new McpServer({ name: 'legacy-only', version: '1.0.0' });
    s.registerTool('legacy_add', { description: 'Adds two numbers.', inputSchema: z.object({ a: z.number(), b: z.number() }) }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
    return s;
  });
  const { server, base } = await serve((req) => h(req));
  return { url: `${base}/mcp`, close: () => close(server) };
}

export interface ProtectedMcp extends Running {
  base: string;
  /** every request line the authorization and resource servers saw */
  seen: { method: string; url: string; auth: string | null; body: string }[];
  /** what the client registered (dynamic registration) */
  registered: Record<string, unknown>[];
  /** sent with the authorization request */
  authorizeParams: URLSearchParams[];
  tokenParams: URLSearchParams[];
  /** access and refresh tokens handed out */
  issued: string[];
  /** advertise Client ID Metadata Document support */
  cimd: boolean;
  /** put a different issuer in the callback (mix-up attack) */
  wrongIss: boolean;
}

/** An MCP server behind OAuth 2.1, with its own authorization server on the same origin. */
export async function startProtectedMcp(): Promise<ProtectedMcp> {
  const codes = new Map<string, { challenge: string; resource: string; clientId: string; redirect: string }>();
  const tokens = new Set<string>();
  const mcp = createMcpHandler(() => {
    const s = new McpServer({ name: 'protected', version: '1.0.0' });
    s.registerTool('secret_report', { description: 'Returns the quarterly report.', inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'Q3 revenue: 42 apples' }] }));
    return s;
  });
  const state: ProtectedMcp = { url: '', base: '', seen: [], registered: [], authorizeParams: [], tokenParams: [], issued: [], cimd: false, wrongIss: false, close: async () => undefined };
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req: http.IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const { server, base } = await serve(
    async (req) => {
      const auth = req.headers.get('authorization') ?? '';
      const tok = /^Bearer (.+)$/.exec(auth)?.[1];
      if (!tok || !tokens.has(tok)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp", scope="reports"` },
        });
      }
      return mcp.fetch(req);
    },
    (req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname === '/mcp') {
        state.seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? null, body: '' });
        return false;
      }
      void (async () => {
        const body = req.method === 'POST' ? await readBody(req) : '';
        state.seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization ?? null, body });
        if (u.pathname === '/.well-known/oauth-protected-resource/mcp' || u.pathname === '/.well-known/oauth-protected-resource') {
          return json(res, 200, { resource: `${state.base}/mcp`, authorization_servers: [state.base], scopes_supported: ['reports'] });
        }
        if (u.pathname === '/.well-known/oauth-authorization-server' || u.pathname === '/.well-known/openid-configuration') {
          return json(res, 200, {
            issuer: state.base,
            authorization_endpoint: `${state.base}/authorize`,
            token_endpoint: `${state.base}/token`,
            registration_endpoint: `${state.base}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            authorization_response_iss_parameter_supported: true,
            client_id_metadata_document_supported: state.cimd,
          });
        }
        if (u.pathname === '/register' && req.method === 'POST') {
          const m = JSON.parse(body) as Record<string, unknown>;
          state.registered.push(m);
          return json(res, 201, { ...m, client_id: `dyn-${randomBytes(6).toString('hex')}`, client_id_issued_at: Math.floor(Date.now() / 1000) });
        }
        if (u.pathname === '/authorize') {
          state.authorizeParams.push(u.searchParams);
          const code = randomBytes(12).toString('hex');
          codes.set(code, { challenge: u.searchParams.get('code_challenge') ?? '', resource: u.searchParams.get('resource') ?? '', clientId: u.searchParams.get('client_id') ?? '', redirect: u.searchParams.get('redirect_uri') ?? '' });
          const back = new URL(u.searchParams.get('redirect_uri')!);
          back.searchParams.set('code', code);
          back.searchParams.set('state', u.searchParams.get('state') ?? '');
          back.searchParams.set('iss', state.wrongIss ? 'https://evil.example' : state.base);
          res.writeHead(302, { location: back.href });
          return res.end();
        }
        if (u.pathname === '/token' && req.method === 'POST') {
          const p = new URLSearchParams(body);
          state.tokenParams.push(p);
          if (p.get('grant_type') === 'authorization_code') {
            const c = codes.get(p.get('code') ?? '');
            codes.delete(p.get('code') ?? '');
            const verifier = p.get('code_verifier') ?? '';
            const ok = c && createHash('sha256').update(verifier).digest('base64url') === c.challenge && p.get('resource') === c.resource && p.get('redirect_uri') === c.redirect;
            if (!ok) return json(res, 400, { error: 'invalid_grant' });
          } else if (p.get('grant_type') !== 'refresh_token') return json(res, 400, { error: 'unsupported_grant_type' });
          const access = `at-${randomBytes(16).toString('hex')}`;
          const refresh = `rt-${randomBytes(16).toString('hex')}`;
          tokens.add(access);
          state.issued.push(access, refresh);
          return json(res, 200, { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'reports' });
        }
        json(res, 404, { error: 'not_found' });
      })();
      return true;
    },
  );
  state.base = base;
  state.url = `${base}/mcp`;
  state.close = () => close(server);
  return state;
}

/** fetch() over HTTPS that trusts exactly one certificate (this server's self-signed one). */
export function pinnedFetch(certPem: string): typeof fetch {
  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url);
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      const r = https.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: req.method, headers, ca: certPem, minVersion: 'TLSv1.3' }, (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
        const status = res.statusCode ?? 500;
        const stream = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream);
        resolve(new Response(stream, { status, headers: h }));
      });
      r.on('error', reject);
      req.signal?.addEventListener('abort', () => r.destroy(new Error('aborted')), { once: true });
      if (body) r.write(body);
      r.end();
    });
  };
}
