// Encrypted key backup (NFR-SEC-05): master key + device registry + TLS identity, sealed
// under an Argon2id passphrase. Restorable on a new server.
import fs from 'node:fs';
import path from 'node:path';
import { seal, open, utf8, fromUtf8, randomBytes, toB64url, fromB64url, passphraseKey, DEFAULT_ARGON2, type Argon2Params } from '@advence/protocol';
import type { DB } from './db.js';

interface BackupPayload {
  v: 1;
  createdAt: number;
  masterKey: string;
  tls: { certPem: string; keyPem: string };
  users: Record<string, unknown>[];
  devices: (Record<string, unknown> & { public_key: string })[];
}

export interface BackupFile {
  v: 1;
  kind: 'advence-key-backup';
  kdf: 'argon2id';
  params: Argon2Params;
  salt: string;
  data: string;
}

export async function createBackup(p: { db: DB; master: Uint8Array; tls: { certPem: string; keyPem: string }; passphrase: string; params?: Argon2Params }): Promise<BackupFile> {
  const users = p.db.prepare('SELECT * FROM users').all() as Record<string, unknown>[];
  const devices = (p.db.prepare('SELECT * FROM devices').all() as (Record<string, unknown> & { public_key: Buffer })[]).map((d) => ({
    ...d,
    public_key: toB64url(new Uint8Array(d.public_key)),
  }));
  const payload: BackupPayload = { v: 1, createdAt: Date.now(), masterKey: toB64url(p.master), tls: p.tls, users, devices };
  const salt = randomBytes(16);
  const params = p.params ?? DEFAULT_ARGON2;
  const k = await passphraseKey(p.passphrase, salt, params);
  return { v: 1, kind: 'advence-key-backup', kdf: 'argon2id', params, salt: toB64url(salt), data: toB64url(seal(k, utf8(JSON.stringify(payload)), 'backup:v1')) };
}

export async function readBackup(b: BackupFile, passphrase: string): Promise<BackupPayload> {
  if (b.v !== 1 || b.kind !== 'advence-key-backup') throw new Error('not a key backup file');
  const k = await passphraseKey(passphrase, fromB64url(b.salt), b.params);
  let plain: Uint8Array;
  try {
    plain = open(k, fromB64url(b.data), 'backup:v1');
  } catch {
    throw new Error('wrong passphrase or corrupted backup');
  }
  return JSON.parse(fromUtf8(plain)) as BackupPayload;
}

/** Imports users and devices into a fresh state DB. Existing rows with the same id are kept. */
export function importRegistry(db: DB, payload: BackupPayload): { users: number; devices: number } {
  let users = 0;
  let devices = 0;
  db.transaction(() => {
    for (const u of payload.users) {
      users += db
        .prepare('INSERT OR IGNORE INTO users(id, google_sub, email, name, picture, role, created_at, last_login_at) VALUES(@id,@google_sub,@email,@name,@picture,@role,@created_at,@last_login_at)')
        .run(u).changes;
    }
    for (const d of payload.devices) {
      devices += db
        .prepare('INSERT OR IGNORE INTO devices(id, user_id, name, platform, public_key, status, created_at, last_seen_at, revoked_at) VALUES(@id,@user_id,@name,@platform,@public_key,@status,@created_at,@last_seen_at,@revoked_at)')
        .run({ ...d, public_key: Buffer.from(fromB64url(d.public_key)) }).changes;
    }
  })();
  return { users, devices };
}

export function writeBackupFile(file: string, b: BackupFile): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(b, null, 2), { mode: 0o600 });
}
