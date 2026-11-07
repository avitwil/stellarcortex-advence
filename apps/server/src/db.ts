// SQLite state store (D-02). Secrets and content columns hold sealed envelopes (NFR-SEC-04).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // 1: foundation (P1)
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (name TEXT PRIMARY KEY, sealed BLOB NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    google_sub TEXT UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    picture TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner','member')),
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE UNIQUE INDEX users_email ON users(email);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    public_key BLOB NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending','active','revoked')),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE pairing_tokens (
    token_hash TEXT PRIMARY KEY,
    created_by TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE pairings (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    token_hash TEXT NOT NULL,
    code TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    device_id TEXT NOT NULL REFERENCES devices(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE nonces (device_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (device_id, nonce));
  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    purpose TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB, extra: string[] = []): void {
  const all = [...MIGRATIONS, ...extra];
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < all.length; i++) {
    db.transaction(() => {
      db.exec(all[i]!);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function getMeta(db: DB, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
