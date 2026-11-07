// Users, devices, pairing and sessions (FR-GGL-02/03/07, FR-CLI-03, NFR-SEC-02/03).
import { fromB64url, toB64url, pairingCode, encodePairingLink, verifyRequest, SIGNATURE_MAX_SKEW_MS, type Platform, type User, type Device } from '@advence/protocol';
import type { DB } from '../db.js';
import { newId, newToken, hashToken } from '../ids.js';
import type { GoogleIdentity } from './google.js';
import { AuthError } from './google.js';

export const SESSION_TTL_MS = 15 * 60_000;
export const PAIRING_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;

interface UserRow { id: string; google_sub: string | null; email: string; name: string; picture: string | null; role: 'owner' | 'member'; created_at: number }
interface DeviceRow { id: string; user_id: string | null; name: string; platform: Platform; public_key: Buffer; status: 'pending' | 'active' | 'revoked'; created_at: number; last_seen_at: number | null }

export interface AuthContext {
  device: DeviceRow;
  user?: User;
  sessionHash?: string;
}

export class Identity {
  /** Called when a device is revoked so live sockets can be closed at once. */
  onRevoke: (deviceId: string) => void = () => undefined;
  onLogout: (deviceId: string) => void = () => undefined;

  constructor(private db: DB, private serverPin: () => string, private now: () => number = Date.now) {}

  // ---------- users / allowlist
  hasOwner(): boolean {
    return !!this.db.prepare("SELECT 1 FROM users WHERE role='owner' AND google_sub IS NOT NULL").get();
  }

  toUser(r: UserRow): User {
    return { id: r.id, email: r.email, name: r.name, role: r.role, ...(r.picture ? { picture: r.picture } : {}) };
  }

  getUser(id: string): User | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? this.toUser(r) : undefined;
  }

  listAllowlist() {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map((r) => ({
      id: r.id, email: r.email, role: r.role, bound: r.google_sub !== null, createdAt: r.created_at,
    }));
  }

  addAllowlist(email: string): string {
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = newId('usr');
    this.db.prepare("INSERT INTO users(id, email, role, created_at) VALUES(?,?,'member',?)").run(id, email.toLowerCase(), this.now());
    return id;
  }

  removeAllowlist(userId: string): void {
    const r = this.db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
    if (!r) return;
    if (r.role === 'owner') throw new AuthError('cannot_remove_owner');
    const revoked = this.db.transaction(() => {
      const devs = this.db.prepare("SELECT id FROM devices WHERE user_id = ? AND status != 'revoked'").all(userId) as { id: string }[];
      this.db.prepare("UPDATE devices SET status='revoked', revoked_at=? WHERE user_id = ? AND status != 'revoked'").run(this.now(), userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      // Revoked devices keep their row for the audit trail but no longer point at the user.
      this.db.prepare('UPDATE devices SET user_id = NULL WHERE user_id = ?').run(userId);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      return devs;
    })();
    for (const d of revoked) this.onRevoke(d.id);
  }

  /**
   * Resolves the account for a verified Google identity (FR-GGL-03). The first login on a
   * server with no owner becomes owner. Unknown accounts are rejected (403).
   */
  resolveLogin(g: GoogleIdentity): User {
    if (!g.emailVerified) throw new AuthError('email_not_verified');
    return this.db.transaction(() => {
      let r = this.db.prepare('SELECT * FROM users WHERE google_sub = ?').get(g.sub) as UserRow | undefined;
      if (!r) {
        if (!this.hasOwner()) {
          // Break-glass reset may have left an unbound owner row; otherwise create one.
          this.db.prepare("UPDATE users SET role='member' WHERE role='owner' AND google_sub IS NULL").run();
          // Only an unbound row may be claimed; a row bound to another Google account never is.
          const same = this.db.prepare('SELECT id FROM users WHERE email = ? AND google_sub IS NULL').get(g.email.toLowerCase()) as { id: string } | undefined;
          if (!same && this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(g.email.toLowerCase())) throw new AuthError('not_allowlisted');
          const id = same?.id ?? newId('usr');
          if (same) this.db.prepare("UPDATE users SET google_sub = ?, name = ?, picture = ?, role = 'owner' WHERE id = ?").run(g.sub, g.name, g.picture ?? null, id);
          else this.db.prepare("INSERT INTO users(id, google_sub, email, name, picture, role, created_at) VALUES(?,?,?,?,?,'owner',?)").run(id, g.sub, g.email.toLowerCase(), g.name, g.picture ?? null, this.now());
          r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
        } else {
          const pending = this.db.prepare('SELECT * FROM users WHERE email = ? AND google_sub IS NULL').get(g.email.toLowerCase()) as UserRow | undefined;
          if (!pending) throw new AuthError('not_allowlisted');
          this.db.prepare('UPDATE users SET google_sub = ?, name = ?, picture = ? WHERE id = ?').run(g.sub, g.name, g.picture ?? null, pending.id);
          r = { ...pending, google_sub: g.sub, name: g.name, picture: g.picture ?? null };
        }
      } else {
        this.db.prepare('UPDATE users SET name = ?, picture = ?, email = ? WHERE id = ?').run(g.name, g.picture ?? null, g.email.toLowerCase(), r.id);
      }
      this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.now(), r.id);
      return this.toUser({ ...r, name: g.name, picture: g.picture ?? null });
    })();
  }

  // ---------- pairing
  createPairingToken(createdBy: string | null, host: string, name: string): { link: string; token: string; expiresAt: number } {
    const token = newToken(24);
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.db.prepare('INSERT INTO pairing_tokens(token_hash, created_by, expires_at) VALUES(?,?,?)').run(hashToken(token), createdBy, expiresAt);
    return { link: encodePairingLink({ host, pin: this.serverPin(), token, name }), token, expiresAt };
  }

  startPairing(p: { token: string; publicKey: string; name: string; platform: Platform }): { pairingId: string; deviceId: string; code: string } {
    const th = hashToken(p.token);
    return this.db.transaction(() => {
      const t = this.db.prepare('SELECT * FROM pairing_tokens WHERE token_hash = ?').get(th) as { expires_at: number; used_at: number | null } | undefined;
      if (!t || t.used_at || t.expires_at < this.now()) throw new AuthError('invalid_pairing_token');
      const pk = Buffer.from(fromB64url(p.publicKey));
      if (pk.length !== 32) throw new AuthError('invalid_public_key');
      if (this.db.prepare('SELECT 1 FROM devices WHERE public_key = ?').get(pk)) throw new AuthError('key_already_registered');
      this.db.prepare('UPDATE pairing_tokens SET used_at = ? WHERE token_hash = ?').run(this.now(), th);
      const deviceId = newId('dev');
      const pairingId = newId('pair');
      this.db.prepare("INSERT INTO devices(id, name, platform, public_key, status, created_at) VALUES(?,?,?,?,'pending',?)").run(deviceId, p.name, p.platform, pk, this.now());
      const code = pairingCode(this.serverPin(), pk, pairingId);
      this.db.prepare("INSERT INTO pairings(id, device_id, token_hash, code, status, created_at, expires_at) VALUES(?,?,?,?,'pending',?,?)").run(pairingId, deviceId, th, code, this.now(), this.now() + PAIRING_TTL_MS);
      return { pairingId, deviceId, code };
    })();
  }

  pendingPairings(tokenHash?: string) {
    this.expirePairings();
    const rows = this.db
      .prepare(`SELECT p.id, p.code, p.created_at, d.name, d.platform FROM pairings p JOIN devices d ON d.id = p.device_id WHERE p.status = 'pending' ${tokenHash ? 'AND p.token_hash = ?' : ''} ORDER BY p.created_at`)
      .all(...(tokenHash ? [tokenHash] : [])) as { id: string; code: string; created_at: number; name: string; platform: Platform }[];
    return rows.map((r) => ({ pairingId: r.id, deviceName: r.name, platform: r.platform, code: r.code, createdAt: r.created_at }));
  }

  /** Approves when the typed code matches; too many wrong codes reject the pairing. */
  approvePairing(pairingId: string, typedCode: string): void {
    this.expirePairings();
    // The attempt counter must persist even when the code is wrong, so the error is
    // raised after the transaction commits (a throw inside would roll it back).
    const outcome = this.db.transaction((): 'ok' | 'mismatch' | 'not_pending' => {
      const p = this.db.prepare('SELECT * FROM pairings WHERE id = ?').get(pairingId) as { device_id: string; code: string; status: string; attempts: number } | undefined;
      if (!p || p.status !== 'pending') return 'not_pending';
      if (!constantTimeEq(p.code, typedCode)) {
        const attempts = p.attempts + 1;
        const status = attempts >= MAX_CODE_ATTEMPTS ? 'rejected' : 'pending';
        this.db.prepare('UPDATE pairings SET attempts = ?, status = ? WHERE id = ?').run(attempts, status, pairingId);
        if (status === 'rejected') this.db.prepare("UPDATE devices SET status='revoked', revoked_at=? WHERE id = ?").run(this.now(), p.device_id);
        return 'mismatch';
      }
      this.db.prepare("UPDATE pairings SET status='approved' WHERE id = ?").run(pairingId);
      // Only a device still waiting for approval can become active; a revoked one never returns.
      this.db.prepare("UPDATE devices SET status='active' WHERE id = ? AND status='pending'").run(p.device_id);
      return 'ok';
    })();
    if (outcome === 'not_pending') throw new AuthError('pairing_not_pending');
    if (outcome === 'mismatch') throw new AuthError('code_mismatch');
  }

  rejectPairing(pairingId: string): void {
    const p = this.db.prepare("SELECT device_id FROM pairings WHERE id = ? AND status='pending'").get(pairingId) as { device_id: string } | undefined;
    if (!p) return;
    this.db.prepare("UPDATE pairings SET status='rejected' WHERE id = ?").run(pairingId);
    this.db.prepare("UPDATE devices SET status='revoked', revoked_at=? WHERE id = ?").run(this.now(), p.device_id);
  }

  pairingStatus(pairingId: string, deviceId: string): 'pending' | 'approved' | 'rejected' | 'expired' {
    this.expirePairings();
    const p = this.db.prepare('SELECT status FROM pairings WHERE id = ? AND device_id = ?').get(pairingId, deviceId) as { status: 'pending' | 'approved' | 'rejected' | 'expired' } | undefined;
    if (!p) throw new AuthError('unknown_pairing');
    return p.status;
  }

  private expirePairings(): void {
    const now = this.now();
    const expired = this.db.prepare("SELECT id, device_id FROM pairings WHERE status='pending' AND expires_at < ?").all(now) as { id: string; device_id: string }[];
    for (const e of expired) {
      this.db.prepare("UPDATE pairings SET status='expired' WHERE id = ?").run(e.id);
      this.db.prepare("UPDATE devices SET status='revoked', revoked_at=? WHERE id = ? AND status='pending'").run(now, e.device_id);
    }
  }

  // ---------- devices
  getDevice(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  listDevices(userId: string | null, currentDeviceId: string, all = false): Device[] {
    const rows = (all
      ? this.db.prepare('SELECT * FROM devices ORDER BY created_at').all()
      : this.db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(userId)) as DeviceRow[];
    return rows.map((r) => ({ id: r.id, name: r.name, platform: r.platform, status: r.status, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === currentDeviceId }));
  }

  revokeDevice(id: string): void {
    this.db.prepare("UPDATE devices SET status='revoked', revoked_at=? WHERE id = ?").run(this.now(), id);
    this.db.prepare("UPDATE pairings SET status='rejected' WHERE device_id = ? AND status='pending'").run(id);
    this.db.prepare('DELETE FROM sessions WHERE device_id = ?').run(id);
    this.onRevoke(id);
  }

  bindDevice(deviceId: string, userId: string): void {
    const d = this.getDevice(deviceId);
    if (!d || d.status !== 'active') throw new AuthError('device_not_active');
    if (d.user_id && d.user_id !== userId) throw new AuthError('device_bound_to_other_user');
    if (!d.user_id) this.db.prepare('UPDATE devices SET user_id = ? WHERE id = ?').run(userId, deviceId);
  }

  // ---------- request signatures (NFR-SEC-02)
  /**
   * Verifies a device signature, timestamp window and nonce. Returns the device row.
   * `allowPending` is used only for the pairing status poll.
   */
  verifySigned(p: { deviceId: string; ts: number; nonce: string; sig: string; method: string; path: string; body: Uint8Array; token: string }, allowPending = false): DeviceRow {
    const d = this.getDevice(p.deviceId);
    if (!d) throw new AuthError('unknown_device');
    if (d.status === 'revoked') throw new AuthError('device_revoked');
    if (d.status === 'pending' && !allowPending) throw new AuthError('device_pending');
    this.checkFreshNonce(p.deviceId, p.ts, p.nonce);
    if (!verifyRequest(new Uint8Array(d.public_key), p, p.sig)) throw new AuthError('bad_signature');
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(this.now(), d.id);
    return d;
  }

  checkFreshNonce(deviceId: string, ts: number, nonce: string): void {
    const now = this.now();
    if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_MAX_SKEW_MS) throw new AuthError('stale_request');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new AuthError('bad_nonce');
    this.db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(now);
    const r = this.db.prepare('INSERT OR IGNORE INTO nonces(device_id, nonce, expires_at) VALUES(?,?,?)').run(deviceId, nonce, now + 2 * SIGNATURE_MAX_SKEW_MS);
    if (r.changes === 0) throw new AuthError('replayed_nonce');
  }

  // ---------- sessions (NFR-SEC-03)
  issueSession(deviceId: string, userId: string): { token: string; expiresAt: number } {
    const token = newToken(32);
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.db.prepare('DELETE FROM sessions WHERE device_id = ? AND expires_at < ?').run(deviceId, this.now());
    this.db.prepare('INSERT INTO sessions(token_hash, device_id, user_id, created_at, expires_at) VALUES(?,?,?,?,?)').run(hashToken(token), deviceId, userId, this.now(), expiresAt);
    return { token, expiresAt };
  }

  /** Refresh through device signature: the device must be active and bound to an allowlisted user. */
  refreshSession(deviceId: string): { token: string; expiresAt: number; user: User } {
    const d = this.getDevice(deviceId);
    if (!d || d.status !== 'active') throw new AuthError('device_not_active');
    if (!d.user_id) throw new AuthError('login_required');
    const u = this.getUser(d.user_id);
    if (!u) throw new AuthError('login_required');
    return { ...this.issueSession(deviceId, u.id), user: u };
  }

  checkSession(token: string, deviceId: string): { user: User; expiresAt: number; hash: string } {
    const h = hashToken(token);
    const s = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(h) as { device_id: string; user_id: string; expires_at: number } | undefined;
    if (!s) throw new AuthError('invalid_session');
    if (s.device_id !== deviceId) throw new AuthError('session_device_mismatch');
    if (s.expires_at <= this.now()) throw new AuthError('session_expired');
    const u = this.getUser(s.user_id);
    if (!u) throw new AuthError('invalid_session');
    return { user: u, expiresAt: s.expires_at, hash: h };
  }

  /**
   * Sign-out: ends every session of the device and unbinds it from the user, so the device
   * signature alone can no longer mint a session; the next use needs Google login again.
   */
  logout(deviceId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE device_id = ?').run(deviceId);
      this.db.prepare('UPDATE devices SET user_id = NULL WHERE id = ?').run(deviceId);
    })();
    this.onLogout(deviceId);
  }

  /** True while the session behind `hash` exists and has not expired. */
  sessionAlive(hash: string): boolean {
    const s = this.db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hash) as { expires_at: number } | undefined;
    return !!s && s.expires_at > this.now();
  }

  // ---------- break-glass (FR-GGL-07)
  /** Resets ownership and revokes every device. Run only from the local CLI. */
  breakGlassReset(): { revokedDevices: number } {
    return this.db.transaction(() => {
      const n = this.db.prepare("UPDATE devices SET status='revoked', revoked_at=? WHERE status != 'revoked'").run(this.now()).changes;
      this.db.prepare('DELETE FROM sessions').run();
      this.db.prepare("UPDATE pairings SET status='rejected' WHERE status='pending'").run();
      this.db.prepare("UPDATE users SET google_sub = NULL WHERE role='owner'").run();
      return { revokedDevices: n };
    })();
  }

  static publicKeyB64(d: DeviceRow): string {
    return toB64url(new Uint8Array(d.public_key));
  }
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
