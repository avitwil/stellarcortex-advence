// Server assembly: boot sequence, Fastify over TLS 1.3, WebSocket gateway.
import { RateLimiter } from './ratelimit.js';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, getMeta, type DB } from './db.js';
import { loadOrCreateMasterKey } from './keystore/master.js';
import { defaultKeystore, type OsKeystore } from './keystore/os.js';
import { Crypto, SecretStore } from './secrets.js';
import { loadOrCreateTls, type TlsIdentity } from './tls.js';
import { Identity } from './auth/identity.js';
import { GoogleOidc, GOOGLE_ENDPOINTS, type GoogleEndpoints } from './auth/google.js';
import { Bus } from './events.js';
import { createLogger, type Logger } from './log.js';
import { registerCoreRoutes } from './routes/core.js';
import { WsGateway } from './ws.js';
import type { AppContext } from './context.js';
import type { ServerConfig } from './config.js';
import { registerFeatures } from './features.js';

export interface BootOptions {
  config: ServerConfig;
  keystore?: OsKeystore | null;
  passphrase?: () => string | undefined;
  googleEndpoints?: GoogleEndpoints;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export interface Server {
  app: FastifyInstance;
  ctx: AppContext;
  ws: WsGateway;
  url: string;
  close(): Promise<void>;
}

export async function boot(o: BootOptions): Promise<{ ctx: AppContext; db: DB; tls: TlsIdentity }> {
  const log = o.logger ?? createLogger();
  const { key, created, method } = await loadOrCreateMasterKey({
    dataDir: o.config.dataDir,
    unlockDir: o.config.unlockDir,
    keystore: o.keystore === undefined ? defaultKeystore() : o.keystore,
    passphrase: o.passphrase,
  });
  log.info({ method }, created ? 'master key created' : 'master key unlocked');
  const db = openDb(path.join(o.config.dataDir, 'state.db'));
  const crypto = new Crypto(key);
  const secrets = new SecretStore(db, crypto);
  const name = () => getMeta(db, 'server.name') ?? 'StellarCortex Advence';
  const tls = await loadOrCreateTls(o.config.dataDir, secrets, name());
  const identity = new Identity(db, () => tls.pin);
  let cached: { id: string; client: GoogleOidc } | null = null;
  const ctx: AppContext = {
    config: o.config,
    db,
    identity,
    secrets,
    crypto,
    bus: new Bus(),
    log,
    tls,
    googleEndpoints: o.googleEndpoints,
    serverName: name,
    publicLimiter: new RateLimiter(20, 60_000),
    google() {
      const id = getMeta(db, 'google.clientId');
      const secret = id ? secrets.get('google.clientSecret') : undefined;
      if (!id || !secret) return null;
      const key = `${id}:${secret}`;
      if (!cached || cached.id !== key) cached = { id: key, client: new GoogleOidc(id, secret, o.googleEndpoints ?? GOOGLE_ENDPOINTS, o.fetchImpl ?? fetch) };
      return cached.client;
    },
  };
  return { ctx, db, tls };
}

export async function startServer(o: BootOptions): Promise<Server> {
  const { ctx, tls } = await boot(o);
  const app = Fastify({
    logger: false,
    bodyLimit: 30 * 1024 * 1024,
    https: { key: tls.keyPem, cert: tls.certPem, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
    trustProxy: false,
    // Shutdown must not wait for clients holding keep-alive connections open.
    forceCloseConnections: true,
  });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    if (body.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch {
      const err = new Error('invalid json') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = body;
    done(null, body);
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header('strict-transport-security', 'max-age=31536000');
  });
  registerCors(app);

  const ws = new WsGateway(ctx);
  ctx.identity.onRevoke = (id) => ws.closeDevice(id);
  ctx.identity.onLogout = (id) => ws.closeDevice(id, 4004, 'signed out');
  registerCoreRoutes(app, ctx);
  await registerFeatures(app, ctx, ws);
  app.server.on('upgrade', (req, socket, head) => ws.handleUpgrade(req, socket, head));

  await app.listen({ host: o.config.host, port: o.config.port });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : o.config.port;
  ctx.log.info({ port }, 'server listening (TLS 1.3)');
  return {
    app,
    ctx,
    ws,
    url: `https://127.0.0.1:${port}`,
    async close() {
      ws.close();
      await app.close();
      ctx.db.close();
    },
  };
}

/** Desktop shells load the UI from app://advence; Android uses its native pinned client. */
const ALLOWED_ORIGINS = new Set(['app://advence']);

function registerCors(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
      reply.header('access-control-allow-headers', 'authorization, content-type, x-advence-device, x-advence-ts, x-advence-nonce, x-advence-sig');
      reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE');
      reply.header('access-control-max-age', '600');
      if (req.method === 'OPTIONS') return reply.code(204).send();
    }
  });
}
