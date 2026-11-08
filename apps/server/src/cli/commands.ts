// Local server CLI: pairing, break-glass admin (FR-GGL-07), backup/restore (NFR-SEC-05).
// These commands need local access to the server's data folder; they never go over the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { openDb, getMeta } from '../db.js';
import { Identity } from '../auth/identity.js';
import { readCertPin } from '../tls.js';
import { loadOrCreateMasterKey, passphraseFile } from '../keystore/master.js';
import { defaultKeystore, type OsKeystore } from '../keystore/os.js';
import { Crypto, SecretStore } from '../secrets.js';
import { createBackup, readBackup, importRegistry, writeBackupFile, type BackupFile } from '../backup.js';
import type { ServerConfig } from '../config.js';
import { wrapWithPassphrase, toB64url, fromB64url } from '@advence/protocol';

export interface CliIO {
  out(s: string): void;
  ask(q: string, hidden?: boolean): Promise<string>;
  sleep(ms: number): Promise<void>;
}

function stateDb(cfg: ServerConfig) {
  const file = path.join(cfg.dataDir, 'state.db');
  if (!fs.existsSync(file)) throw new Error(`no server data at ${cfg.dataDir}; start the server once first`);
  return openDb(file);
}

export function lanHosts(port: number): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`${a.address}:${port}`);
  }
  return out.length ? out : [`localhost:${port}`];
}

/** `advence pair`: prints a pairing QR + link, then approves the device after the code is typed. */
export async function cmdPair(cfg: ServerConfig, io: CliIO, opts: { host?: string; timeoutMs?: number } = {}): Promise<boolean> {
  const db = stateDb(cfg);
  try {
    const pin = readCertPin(cfg.dataDir);
    const identity = new Identity(db, () => pin);
    const host = opts.host ?? lanHosts(cfg.port)[0]!;
    const name = getMeta(db, 'server.name') ?? 'StellarCortex Advence';
    const t = identity.createPairingToken(null, host, name);
    io.out(await QRCode.toString(t.link, { type: 'terminal', small: true }));
    io.out(`Pairing link (valid 10 minutes):\n${t.link}\n`);
    io.out('Scan the QR code in the app, or paste the link. Waiting for the device...\n');
    const { hashToken } = await import('../ids.js');
    const th = hashToken(t.token);
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline) {
      const p = identity.pendingPairings(th)[0];
      if (p) {
        io.out(`Device "${p.deviceName}" (${p.platform}) wants to pair.\n`);
        for (let i = 0; i < 5; i++) {
          const typed = await io.ask('Type the 6-digit code shown on the device (empty to reject): ');
          if (!typed) {
            identity.rejectPairing(p.pairingId);
            io.out('Rejected.\n');
            return false;
          }
          try {
            identity.approvePairing(p.pairingId, typed);
            io.out('Device approved. Continue on the device.\n');
            return true;
          } catch (e) {
            io.out(`Code does not match (${(e as Error).message}).\n`);
            if (identity.pendingPairings(th).length === 0) return false;
          }
        }
        return false;
      }
      await io.sleep(1000);
    }
    io.out('Timed out.\n');
    return false;
  } finally {
    db.close();
  }
}

/** `advence admin reset` (FR-GGL-07): resets the owner and revokes every device, without Google. */
export async function cmdAdminReset(cfg: ServerConfig, io: CliIO, confirm = true): Promise<void> {
  if (confirm) {
    const a = await io.ask('This revokes ALL devices and resets the owner. Type RESET to continue: ');
    if (a !== 'RESET') {
      io.out('Cancelled.\n');
      return;
    }
  }
  const db = stateDb(cfg);
  try {
    const r = new Identity(db, () => '').breakGlassReset();
    io.out(`Reset done: ${r.revokedDevices} device(s) revoked. Run \`advence pair\` to pair a device, then sign in; the first sign-in becomes owner.\n`);
  } finally {
    db.close();
  }
}

export function cmdAdminDevices(cfg: ServerConfig, io: CliIO): void {
  const db = stateDb(cfg);
  try {
    const rows = db.prepare('SELECT d.id, d.name, d.platform, d.status, u.email FROM devices d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.created_at').all() as { id: string; name: string; platform: string; status: string; email: string | null }[];
    for (const r of rows) io.out(`${r.id}  ${r.status.padEnd(8)} ${r.platform.padEnd(8)} ${r.name}  ${r.email ?? ''}\n`);
  } finally {
    db.close();
  }
}

export function cmdAdminRevoke(cfg: ServerConfig, io: CliIO, id: string): void {
  const db = stateDb(cfg);
  try {
    new Identity(db, () => '').revokeDevice(id);
    io.out(`Revoked ${id}.\n`);
  } finally {
    db.close();
  }
}

export async function cmdBackup(cfg: ServerConfig, io: CliIO, out: string, keystore: OsKeystore | null = defaultKeystore(), passphrase?: string): Promise<void> {
  const pass = passphrase ?? (await io.ask('Backup passphrase (min 12 chars): ', true));
  if (pass.length < 12) throw new Error('passphrase must be at least 12 characters');
  if (passphrase === undefined && (await io.ask('Repeat passphrase: ', true)) !== pass) throw new Error('passphrases differ');
  const { key } = await loadOrCreateMasterKey({ dataDir: cfg.dataDir, unlockDir: cfg.unlockDir, keystore });
  const db = stateDb(cfg);
  try {
    const secrets = new SecretStore(db, new Crypto(key));
    const keyPem = secrets.get('tls.key');
    if (!keyPem) throw new Error('no TLS key');
    const certPem = fs.readFileSync(path.join(cfg.dataDir, 'tls-cert.pem'), 'utf8');
    writeBackupFile(out, await createBackup({ db, master: key, tls: { certPem, keyPem }, passphrase: pass }));
    io.out(`Encrypted key backup written to ${out}. Keep the passphrase safe; it cannot be recovered.\n`);
  } finally {
    db.close();
  }
}

/** Restores master key, TLS identity and device registry into an empty data folder. */
export async function cmdRestore(cfg: ServerConfig, io: CliIO, input: string, keystore: OsKeystore | null = defaultKeystore(), passphrase?: string): Promise<void> {
  if (fs.existsSync(path.join(cfg.dataDir, 'master.json'))) throw new Error(`refusing to overwrite existing server data at ${cfg.dataDir}`);
  const b = JSON.parse(fs.readFileSync(input, 'utf8')) as BackupFile;
  const pass = passphrase ?? (await io.ask('Backup passphrase: ', true));
  const payload = await readBackup(b, pass);
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const master = fromB64url(payload.masterKey);
  // Re-wrap the master key for this machine.
  let mf: Record<string, unknown>;
  if (keystore && (await keystore.available())) {
    const blob = await keystore.store('master', toB64url(master));
    mf = { v: 1, method: 'os-keystore', keystore: keystore.name, ...(blob ? { blob } : {}), createdAt: Date.now() };
  } else {
    const { readOrCreatePassphrase } = await import('../keystore/master.js');
    const unlock = readOrCreatePassphrase(cfg.unlockDir, true)!;
    mf = { v: 1, method: 'passphrase', wrapped: await wrapWithPassphrase(master, unlock, 'master'), createdAt: Date.now() };
  }
  fs.writeFileSync(path.join(cfg.dataDir, 'master.json'), JSON.stringify(mf, null, 2), { mode: 0o600 });
  const db = openDb(path.join(cfg.dataDir, 'state.db'));
  try {
    new SecretStore(db, new Crypto(master)).set('tls.key', payload.tls.keyPem);
    fs.writeFileSync(path.join(cfg.dataDir, 'tls-cert.pem'), payload.tls.certPem);
    const n = importRegistry(db, payload);
    io.out(`Restored master key, TLS identity, ${n.users} user(s) and ${n.devices} device(s).\n`);
  } finally {
    db.close();
  }
}

/** `advence unlock`: recreates the unlock passphrase file outside the data folder. */
export async function cmdUnlock(cfg: ServerConfig, io: CliIO): Promise<void> {
  const f = passphraseFile(cfg.unlockDir);
  if (fs.existsSync(f)) {
    io.out(`Unlock file already present at ${f}.\n`);
    return;
  }
  const p = await io.ask('Unlock passphrase: ', true);
  fs.mkdirSync(cfg.unlockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, p + '\n', { mode: 0o600 });
  try {
    await loadOrCreateMasterKey({ dataDir: cfg.dataDir, unlockDir: cfg.unlockDir, keystore: null });
    io.out('Unlocked.\n');
  } catch (e) {
    fs.rmSync(f);
    throw e;
  }
}
