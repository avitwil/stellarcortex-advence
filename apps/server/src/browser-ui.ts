// Opt-in browser UI (D-16, FR-CLI-04): off by default. When on, the same bundled React UI
// is served over the pinned TLS port with a strict CSP; the bundle carries SRI hashes.
// Every API call still needs a paired, approved device key and a Google session.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { getMeta } from './db.js';
import type { AppContext } from './context.js';

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:", "font-src 'self'",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "frame-src 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
};

export function defaultUiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.ADVENCE_UI_DIR, path.resolve(here, '../../ui/dist'), path.resolve(here, '../ui')].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html'))) ?? candidates[candidates.length - 1]!;
}

export function registerBrowserUi(app: FastifyInstance, ctx: AppContext, uiDir = defaultUiDir()): void {
  const root = path.resolve(uiDir);
  app.get('/*', async (req, reply) => {
    if (getMeta(ctx.db, 'settings.browserUi') !== 'true') return reply.code(404).send({ error: 'not_found' });
    const urlPath = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, '')) || 'index.html';
    const file = path.resolve(root, urlPath);
    if (!file.startsWith(root + path.sep) && file !== root) return reply.code(404).send({ error: 'not_found' });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root, 'index.html');
    if (!fs.existsSync(target)) return reply.code(404).send({ error: 'not_found' });
    reply.header('content-security-policy', CSP);
    reply.header('x-frame-options', 'DENY');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
    reply.type(TYPES[path.extname(target)] ?? 'application/octet-stream');
    return reply.send(fs.readFileSync(target));
  });
}
