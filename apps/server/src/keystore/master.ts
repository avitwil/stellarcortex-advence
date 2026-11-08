// Master key management (NFR-SEC-04, NFR-SEC-05). The master key never touches disk in
// plaintext. It is wrapped by an OS keystore when one is usable, otherwise by an Argon2id
// passphrase kept in a file outside the data folder (DL-010).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, toB64url, fromB64url, wrapWithPassphrase, unwrapWithPassphrase, type WrappedKey } from '@advence/protocol';
import type { OsKeystore } from './os.js';

export interface MasterKeyFile {
  v: 1;
  method: 'os-keystore' | 'passphrase';
  keystore?: string;
  /** opaque blob some keystores return (DPAPI); others store the key themselves */
  blob?: string;
  wrapped?: WrappedKey;
  createdAt: number;
}

export interface MasterKeyOptions {
  dataDir: string;
  unlockDir: string;
  keystore: OsKeystore | null;
  /** passphrase source used when no keystore is usable */
  passphrase?: () => string | undefined;
}

const FILE = 'master.json';

export function passphraseFile(unlockDir: string): string {
  return path.join(unlockDir, 'passphrase');
}

/** Reads the unlock passphrase file, creating a strong random one at first install. */
export function readOrCreatePassphrase(unlockDir: string, create: boolean): string | undefined {
  const f = passphraseFile(unlockDir);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  if (!create) return undefined;
  fs.mkdirSync(unlockDir, { recursive: true, mode: 0o700 });
  const p = toB64url(randomBytes(32));
  fs.writeFileSync(f, p + '\n', { mode: 0o600, flag: 'wx' });
  return p;
}

export async function loadOrCreateMasterKey(o: MasterKeyOptions): Promise<{ key: Uint8Array; created: boolean; method: MasterKeyFile['method'] }> {
  const file = path.join(o.dataDir, FILE);
  if (fs.existsSync(file)) {
    const mf = JSON.parse(fs.readFileSync(file, 'utf8')) as MasterKeyFile;
    return { key: await unwrap(mf, o), created: false, method: mf.method };
  }
  fs.mkdirSync(o.dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  const mf = await wrap(key, o);
  fs.writeFileSync(file, JSON.stringify(mf, null, 2), { mode: 0o600, flag: 'wx' });
  return { key, created: true, method: mf.method };
}

async function wrap(key: Uint8Array, o: MasterKeyOptions): Promise<MasterKeyFile> {
  if (o.keystore && (await o.keystore.available())) {
    const blob = await o.keystore.store('master', toB64url(key));
    return { v: 1, method: 'os-keystore', keystore: o.keystore.name, ...(blob ? { blob } : {}), createdAt: Date.now() };
  }
  const pass = o.passphrase?.() ?? readOrCreatePassphrase(o.unlockDir, true);
  if (!pass) throw new Error('no passphrase available to wrap the master key');
  return { v: 1, method: 'passphrase', wrapped: await wrapWithPassphrase(key, pass, 'master'), createdAt: Date.now() };
}

async function unwrap(mf: MasterKeyFile, o: MasterKeyOptions): Promise<Uint8Array> {
  if (mf.method === 'os-keystore') {
    if (!o.keystore || o.keystore.name !== mf.keystore) throw new Error(`master key is held by keystore "${mf.keystore}", which is not available`);
    const v = await o.keystore.load('master', mf.blob);
    if (!v) throw new Error('master key not found in OS keystore');
    return fromB64url(v);
  }
  const pass = o.passphrase?.() ?? readOrCreatePassphrase(o.unlockDir, false);
  if (!pass) throw new Error('locked: the unlock passphrase file is missing; run `advence unlock`');
  if (!mf.wrapped) throw new Error('corrupt master key file');
  return unwrapWithPassphrase(mf.wrapped, pass, 'master');
}
