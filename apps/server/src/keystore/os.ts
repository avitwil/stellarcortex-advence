// OS keystore adapters (DL-010). Each shells out to the OS tool; no native modules.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface OsKeystore {
  name: string;
  available(): Promise<boolean>;
  /** Stores the value. May return an opaque blob that must be kept and passed to load(). */
  store(account: string, value: string): Promise<string | undefined>;
  load(account: string, blob?: string): Promise<string | undefined>;
}

const SERVICE = 'stellarcortex-advence';

export const secretServiceKeystore: OsKeystore = {
  name: 'linux-secret-service',
  async available() {
    if (process.platform !== 'linux' || !process.env.DBUS_SESSION_BUS_ADDRESS) return false;
    try {
      await run('secret-tool', ['--version'], { timeout: 3000 });
      const probe = `probe-${Date.now()}`;
      await this.store('probe', probe);
      const ok = (await this.load('probe')) === probe;
      await run('secret-tool', ['clear', 'service', SERVICE, 'account', 'probe'], { timeout: 3000 }).catch(() => undefined);
      return ok;
    } catch {
      return false;
    }
  },
  async store(account, value) {
    await new Promise<void>((resolve, reject) => {
      const p = execFile('secret-tool', ['store', '--label', `${SERVICE} ${account}`, 'service', SERVICE, 'account', account], { timeout: 5000 }, (e) => (e ? reject(e) : resolve()));
      p.stdin?.end(value);
    });
    return undefined;
  },
  async load(account) {
    const { stdout } = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account], { timeout: 5000 });
    return stdout.trim() || undefined;
  },
};

export const macKeychain: OsKeystore = {
  name: 'macos-keychain',
  async available() {
    if (process.platform !== 'darwin') return false;
    try {
      await run('security', ['show-keychain-info'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  },
  async store(account, value) {
    // The value goes through stdin (interactive mode), never argv, so `ps` cannot see it.
    if (!/^[A-Za-z0-9._-]+$/.test(account) || !/^[A-Za-z0-9+/=_-]+$/.test(value)) throw new Error('unsupported keychain value');
    await new Promise<void>((resolve, reject) => {
      const p = execFile('security', ['-i'], { timeout: 5000 }, (e) => (e ? reject(e) : resolve()));
      p.stdin?.end(`add-generic-password -U -a ${account} -s ${SERVICE} -w ${value}\n`);
    });
    return undefined;
  },
  async load(account) {
    const { stdout } = await run('security', ['find-generic-password', '-a', account, '-s', SERVICE, '-w'], { timeout: 5000 });
    return stdout.trim() || undefined;
  },
};

/** Windows DPAPI (CurrentUser scope) through PowerShell; the returned blob is stored in master.json. */
export const windowsDpapi: OsKeystore = {
  name: 'windows-dpapi',
  async available() {
    return process.platform === 'win32';
  },
  async store(_account, value) {
    const script = `Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))`;
    return await psStdin(script, value);
  },
  async load(_account, blob) {
    if (!blob) return undefined;
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`;
    return await psStdin(script, blob);
  },
};

function psStdin(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000 }, (e, out) => (e ? reject(e) : resolve(String(out).trim())));
    p.stdin?.end(input);
  });
}

export function defaultKeystore(): OsKeystore | null {
  if (process.platform === 'win32') return windowsDpapi;
  if (process.platform === 'darwin') return macKeychain;
  if (process.platform === 'linux') return secretServiceKeystore;
  return null;
}
