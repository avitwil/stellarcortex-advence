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
  // 2: bots and chat (P2). Content columns are sealed under the content key (NFR-SEC-04).
  `
  ALTER TABLE users ADD COLUMN removed_at INTEGER;
  CREATE TABLE model_sources (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    instructions BLOB NOT NULL,
    source_id TEXT REFERENCES model_sources(id) ON DELETE SET NULL,
    model TEXT NOT NULL DEFAULT '',
    engine TEXT NOT NULL,
    tools TEXT NOT NULL DEFAULT '[]',
    is_primary INTEGER NOT NULL DEFAULT 0,
    proactive INTEGER NOT NULL DEFAULT 0,
    host_control INTEGER NOT NULL DEFAULT 0,
    notify TEXT NOT NULL DEFAULT 'all',
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE INDEX bots_user ON bots(user_id);
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('direct','group')),
    title BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE INDEX conversations_user ON conversations(user_id, updated_at);
  CREATE TABLE conversation_bots (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, bot_id)
  );
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name BLOB NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author TEXT NOT NULL CHECK (author IN ('user','bot','system')),
    user_id TEXT,
    bot_id TEXT,
    body BLOB NOT NULL,
    parent_id TEXT,
    status TEXT NOT NULL DEFAULT 'done',
    error TEXT,
    client_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (conversation_id, client_id)
  );
  CREATE INDEX messages_conv ON messages(conversation_id, created_at);
  CREATE TABLE message_attachments (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL REFERENCES attachments(id),
    PRIMARY KEY (message_id, attachment_id)
  );
  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE TABLE drafts (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    body BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id)
  );
  CREATE TABLE reads (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id)
  );
  CREATE TABLE library (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    bot_id TEXT,
    kind TEXT NOT NULL,
    body BLOB NOT NULL,
    attachment_id TEXT,
    message_id TEXT,
    conversation_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX library_user ON library(user_id, created_at);
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX usage_user ON usage(user_id);
  CREATE TABLE push_endpoints (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    endpoint BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    bot_id TEXT,
    kind TEXT NOT NULL,
    summary BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX activity_user ON activity(user_id, created_at);
  `,
  // P3: Bot computers, coding engine sessions and activity (FR-PC-*, FR-CODE-*).
  `
  ALTER TABLE messages ADD COLUMN steps BLOB;
  CREATE TABLE computers (
    bot_id TEXT PRIMARY KEY REFERENCES bots(id),
    cpus REAL,
    memory_mb INTEGER,
    disk_gb INTEGER,
    disk_full INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE engine_sessions (
    bot_id TEXT NOT NULL REFERENCES bots(id),
    conversation_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    session BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, conversation_id, engine)
  );
  `,
  // P4: skills with usage telemetry (FR-LRN-04) and third-party installs awaiting the owner
  // (FR-SKL-02). Names and sources are sealed; lookups use a keyed hash of the name.
  `
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    bot_id TEXT REFERENCES bots(id),
    name_hash TEXT NOT NULL,
    meta BLOB NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    pinned INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0,
    patches INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX skills_name ON skills(user_id, IFNULL(bot_id, ''), name_hash);
  CREATE TABLE skill_reviews (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    skill_id TEXT REFERENCES skills(id),
    body BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // P5: MCP servers the Bots use (FR-MCP-01/05) with their OAuth state (FR-MCP-03), access
  // tokens for external clients of this server (FR-MCP-04), and Google connections (FR-GGL-04/05).
  // Configurations, OAuth state and tokens are sealed; access tokens are stored as hashes.
  `
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    config BLOB NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_auth (
    server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
    body BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE mcp_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    name BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    last_used INTEGER
  );
  CREATE TABLE google_connections (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    body BLOB NOT NULL,
    state TEXT NOT NULL,
    connected_at INTEGER NOT NULL,
    expires_at INTEGER,
    reminded_at INTEGER
  );
  `,
  // P6: proactive Bots (FR-PRO-*, FR-UI-06, NFR-SEC-11).
  `
  ALTER TABLE bots ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    bot_id TEXT NOT NULL REFERENCES bots(id),
    body BLOB NOT NULL,
    kind TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    next_run INTEGER,
    hook_hash TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX routines_user ON routines(user_id);
  CREATE UNIQUE INDEX routines_hook ON routines(hook_hash) WHERE hook_hash IS NOT NULL;
  CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    routine_id TEXT,
    bot_id TEXT NOT NULL,
    status TEXT NOT NULL,
    body BLOB NOT NULL,
    conv_id TEXT,
    message_id TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX routine_runs_routine ON routine_runs(routine_id, started_at);
  CREATE INDEX routine_runs_user ON routine_runs(user_id, status);
  CREATE TABLE suggestions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    bot_id TEXT NOT NULL,
    body BLOB NOT NULL,
    rank INTEGER NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX suggestions_user ON suggestions(user_id, status);
  CREATE TABLE held_actions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    bot_id TEXT NOT NULL,
    conv_id TEXT NOT NULL,
    body BLOB NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX held_user ON held_actions(user_id, status);
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
