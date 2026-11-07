// Google services (FR-GGL-04, FR-GGL-05): the user's connection, one consent for all four
// services, and disconnect. Desktop/browser use the loopback redirect with PKCE; Android sends a
// server auth code from Google's authorization client.
import type { FastifyInstance } from 'fastify';
import { GoogleConnectFinish, GoogleConnectStart } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { parse, router, userOf } from '../http.js';
import type { GoogleConnections } from '../google/connections.js';

export function registerGoogleRoutes(app: FastifyInstance, ctx: AppContext, conns: GoogleConnections): void {
  const route = router(app, ctx);
  route('GET', '/v1/google', 'session', (req) => conns.get(userOf(req)));
  route('GET', '/v1/google/connect', 'session', () => conns.info());
  route('POST', '/v1/google/connect/start', 'session', (req) => conns.start(userOf(req), req.auth!.deviceId, parse(GoogleConnectStart, req.body)));
  route('POST', '/v1/google/connect/finish', 'session', (req) => conns.finish(userOf(req), req.auth!.deviceId, parse(GoogleConnectFinish, req.body)));
  route('DELETE', '/v1/google', 'session', (req) => conns.disconnect(userOf(req)));
}
