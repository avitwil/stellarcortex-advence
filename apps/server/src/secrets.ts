// Sealed secret storage (API keys, OAuth tokens, TLS key) under the master key (NFR-SEC-04).
import { seal, open, deriveKey, utf8, fromUtf8 } from '@advence/protocol';
import type { DB } from './db.js';
import { registerSecret } from './redact.js';

export class Crypto {
  readonly secretsKey: Uint8Array;
  readonly contentKey: Uint8Array;
  readonly vaultKey: Uint8Array;
  constructor(readonly master: Uint8Array) {
    this.secretsKey = deriveKey(master, 'secrets');
    this.contentKey = deriveKey(master, 'content');
    this.vaultKey = deriveKey(master, 'vault');
  }
  sealContent(text: string, aad: string): Buffer {
    return Buffer.from(seal(this.contentKey, utf8(text), `content:${aad}`));
  }
  openContent(blob: Uint8Array, aad: string): string {
    return fromUtf8(open(this.contentKey, blob, `content:${aad}`));
  }
  sealBytes(data: Uint8Array, aad: string): Buffer {
    return Buffer.from(seal(this.contentKey, data, `bytes:${aad}`));
  }
  openBytes(blob: Uint8Array, aad: string): Uint8Array {
    return open(this.contentKey, blob, `bytes:${aad}`);
  }
}

export class SecretStore {
  constructor(private db: DB, private crypto: Crypto) {}

  set(name: string, value: string): void {
    const sealed = Buffer.from(seal(this.crypto.secretsKey, utf8(value), `secret:${name}`));
    this.db
      .prepare('INSERT INTO secrets(name, sealed, updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET sealed=excluded.sealed, updated_at=excluded.updated_at')
      .run(name, sealed, Date.now());
    registerSecret(value);
  }

  get(name: string): string | undefined {
    const r = this.db.prepare('SELECT sealed FROM secrets WHERE name = ?').get(name) as { sealed: Buffer } | undefined;
    if (!r) return undefined;
    const v = fromUtf8(open(this.crypto.secretsKey, r.sealed, `secret:${name}`));
    registerSecret(v);
    return v;
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
  }

  list(prefix: string): string[] {
    return (this.db.prepare("SELECT name FROM secrets WHERE name LIKE ? ESCAPE '\\'").all(prefix.replace(/[%_\\]/g, '\\$&') + '%') as { name: string }[]).map((r) => r.name);
  }
}
