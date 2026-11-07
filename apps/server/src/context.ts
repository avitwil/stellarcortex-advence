import type { RateLimiter } from './ratelimit.js';
import type { DB } from './db.js';
import type { Identity } from './auth/identity.js';
import type { SecretStore, Crypto } from './secrets.js';
import type { Bus } from './events.js';
import type { Logger } from './log.js';
import type { GoogleOidc, GoogleEndpoints } from './auth/google.js';
import type { ServerConfig } from './config.js';
import type { TlsIdentity } from './tls.js';

export interface AppContext {
  config: ServerConfig;
  db: DB;
  identity: Identity;
  secrets: SecretStore;
  crypto: Crypto;
  bus: Bus;
  log: Logger;
  tls: TlsIdentity;
  /** null until the setup wizard stored the Google Web client */
  google(): GoogleOidc | null;
  googleEndpoints?: GoogleEndpoints;
  serverName(): string;
  /** Per-IP limit for unauthenticated routes. */
  publicLimiter: RateLimiter;
}
