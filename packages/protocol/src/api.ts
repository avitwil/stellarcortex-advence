// REST API schemas shared by server and clients (zod). Every route lives under /v1.
import { z } from 'zod';

export const API_PREFIX = '/v1';
export const DEFAULT_PORT = 4443;
/** Fixed loopback redirect for desktop Google login (see docs/decisions.md). */
export const DESKTOP_OAUTH_REDIRECT = 'http://localhost:47823/oauth/callback';

export const Platform = z.enum(['windows', 'macos', 'linux', 'android', 'browser']);
export type Platform = z.infer<typeof Platform>;

export const B64Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'expected 32-byte base64url');

export const ServerInfo = z.object({
  name: z.string(),
  version: z.string(),
  setupRequired: z.boolean(),
  hasOwner: z.boolean(),
  googleConfigured: z.boolean(),
  browserUi: z.boolean(),
});
export type ServerInfo = z.infer<typeof ServerInfo>;

// ---- Pairing (FR-CLI-03, NFR-SEC-02)
export const PairStartReq = z.object({
  token: z.string().min(16).max(128),
  publicKey: B64Key,
  name: z.string().min(1).max(64),
  platform: Platform,
});
export const PairStartRes = z.object({ pairingId: z.string(), deviceId: z.string(), code: z.string().regex(/^\d{6}$/) });
export const PairStatusRes = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'expired']) });
export const PairApproveReq = z.object({ code: z.string().regex(/^\d{6}$/) });
export const PendingPairing = z.object({
  pairingId: z.string(),
  deviceName: z.string(),
  platform: Platform,
  code: z.string(),
  createdAt: z.number(),
});
export const PairingTokenRes = z.object({ link: z.string(), expiresAt: z.number() });

// ---- Setup wizard (FR-GGL-01)
export const SetupInfoRes = z.object({
  webRedirectUri: z.string(),
  androidPackage: z.string(),
  androidSha1: z.string(),
  scopes: z.array(z.string()),
  steps: z.array(z.object({ id: z.string(), url: z.string().optional() })),
});
export const SetupGoogleReq = z.object({
  clientId: z.string().regex(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/, 'not a Google OAuth client ID'),
  clientSecret: z.string().min(10).max(200),
});

// ---- Auth (FR-GGL-02, FR-GGL-03, NFR-SEC-03)
export const GoogleStartReq = z.object({
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  redirectUri: z.string().url(),
});
export const GoogleStartRes = z.object({ url: z.string().url(), state: z.string() });
export const GoogleFinishReq = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(16).max(128),
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
export const GoogleIdTokenReq = z.object({ idToken: z.string().min(20).max(8192) });

export const UserRole = z.enum(['owner', 'member']);
export const User = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: UserRole,
  picture: z.string().optional(),
});
export type User = z.infer<typeof User>;

export const SessionRes = z.object({ token: z.string(), expiresAt: z.number(), user: User });
export type SessionRes = z.infer<typeof SessionRes>;

export const Device = z.object({
  id: z.string(),
  name: z.string(),
  platform: Platform,
  status: z.enum(['pending', 'active', 'revoked']),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  current: z.boolean(),
});
export type Device = z.infer<typeof Device>;

export const AllowlistEntry = z.object({
  id: z.string(),
  email: z.string(),
  role: UserRole,
  bound: z.boolean(),
  createdAt: z.number(),
});
export const AddAllowlistReq = z.object({ email: z.string().email() });

export const ApiError = z.object({ error: z.string(), message: z.string().optional() });
