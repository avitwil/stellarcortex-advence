// Server configuration. Defaults follow the spec; everything else is fixed (scope rule).
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from '@advence/protocol';

export interface ServerConfig {
  dataDir: string;
  /** Directory outside dataDir holding the unlock passphrase when no OS keystore exists. */
  unlockDir: string;
  host: string;
  port: number;
  version: string;
}

export const VERSION = '0.1.0';

export function defaultDataDir(platform: NodeJS.Platform = process.platform, env = process.env): string {
  if (env.ADVENCE_DATA_DIR) return path.resolve(env.ADVENCE_DATA_DIR);
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Advence', 'data');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Advence', 'data');
  return path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'advence');
}

export function defaultUnlockDir(platform: NodeJS.Platform = process.platform, env = process.env): string {
  if (env.ADVENCE_UNLOCK_DIR) return path.resolve(env.ADVENCE_UNLOCK_DIR);
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Advence', 'unlock');
  if (platform === 'darwin') return path.join(home, 'Library', 'Preferences', 'Advence', 'unlock');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'advence-unlock');
}

export function loadConfig(env = process.env): ServerConfig {
  const port = env.ADVENCE_PORT ? Number(env.ADVENCE_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid ADVENCE_PORT');
  return {
    dataDir: defaultDataDir(process.platform, env),
    unlockDir: defaultUnlockDir(process.platform, env),
    host: env.ADVENCE_HOST ?? '0.0.0.0',
    port,
    version: VERSION,
  };
}
