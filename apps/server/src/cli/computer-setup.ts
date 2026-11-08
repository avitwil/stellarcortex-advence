// `advence computer setup` (FR-PC-07): sets up Podman for Bot computers on this machine and
// builds the image. Linux: rootless Podman with pasta, sub-UIDs and lingering so the computers
// start at boot. Windows: Podman machine on WSL2. macOS: Podman machine. Everything comes from the
// official package sources (C-04: free, never Docker Desktop). The installers (FR-CLI-06) call it.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, setMeta } from '../db.js';
import { BOT_IMAGE } from '../models/host.js';
import { defaultImageDir } from '../computer/manager.js';
import type { ServerConfig } from '../config.js';
import type { CliIO } from './commands.js';

export interface Run { code: number; stdout: string; stderr: string }
export interface SetupDeps {
  platform: NodeJS.Platform;
  user: string;
  uid: number;
  /** runs a program and waits; output is captured */
  run(cmd: string, args: string[]): Promise<Run>;
  /** runs a long program with its output shown to the user */
  runLive(cmd: string, args: string[]): Promise<number>;
  readFile(p: string): string | null;
  cpus: number;
  memoryMb: number;
}

export interface SetupOptions { yes?: boolean; autoStart?: boolean; imageDir?: string; image?: string }

const PODMAN_DOWNLOAD = 'https://podman.io/docs/installation';

/** The package manager command that installs rootless Podman with pasta (or only pasta) on this Linux. */
export async function linuxInstall(d: SetupDeps, only: 'podman' | 'passt' = 'podman'): Promise<string[] | null> {
  const has = async (b: string) => (await d.run('sh', ['-c', `command -v ${b}`])).code === 0;
  const sudo = d.uid === 0 ? [] : ['sudo'];
  const pkgs = (all: string[]) => (only === 'passt' ? ['passt'] : all);
  if (await has('apt-get')) return [...sudo, 'apt-get', 'install', '-y', ...pkgs(['podman', 'passt', 'uidmap', 'fuse-overlayfs'])];
  if (await has('dnf')) return [...sudo, 'dnf', 'install', '-y', ...pkgs(['podman', 'passt'])];
  if (await has('zypper')) return [...sudo, 'zypper', '--non-interactive', 'install', ...pkgs(['podman', 'passt'])];
  if (await has('pacman')) return [...sudo, 'pacman', '-S', '--noconfirm', ...pkgs(['podman', 'passt'])];
  return null;
}

async function confirm(io: CliIO, o: SetupOptions, q: string): Promise<boolean> {
  if (o.yes) return true;
  return /^y(es)?$/i.test((await io.ask(`${q} [y/N] `)).trim());
}

async function step(io: CliIO, d: SetupDeps, o: SetupOptions, why: string, cmd: string[]): Promise<boolean> {
  io.out(`${why}\n  $ ${cmd.join(' ')}\n`);
  if (!(await confirm(io, o, 'Run it now?'))) {
    io.out('Skipped. Run it yourself, then run "advence computer setup" again.\n');
    return false;
  }
  const code = await d.runLive(cmd[0]!, cmd.slice(1));
  if (code !== 0) io.out(`It failed (exit ${code}).\n`);
  return code === 0;
}

/** Returns true when Bot computers are ready on this machine. */
export async function cmdComputerSetup(cfg: ServerConfig, io: CliIO, d: SetupDeps, o: SetupOptions = {}): Promise<boolean> {
  // 1. Podman itself.
  let version = await d.run('podman', ['--version']);
  if (version.code !== 0) {
    let cmd: string[] | null = null;
    if (d.platform === 'linux') cmd = await linuxInstall(d);
    else if (d.platform === 'darwin' && (await d.run('sh', ['-c', 'command -v brew'])).code === 0) cmd = ['brew', 'install', 'podman'];
    else if (d.platform === 'win32' && (await d.run('where', ['winget'])).code === 0) cmd = ['winget', 'install', '-e', '--id', 'RedHat.Podman', '--accept-source-agreements', '--accept-package-agreements'];
    if (!cmd) {
      io.out(`Podman is not installed. Install it from ${PODMAN_DOWNLOAD}, then run "advence computer setup" again.\n`);
      return false;
    }
    if (!(await step(io, d, o, 'Podman is not installed. This installs it from the official packages:', cmd))) return false;
    version = await d.run('podman', ['--version']);
    if (version.code !== 0) {
      io.out('Podman is still not found. Open a new terminal (so PATH is updated) and run this again.\n');
      return false;
    }
  }
  io.out(`${version.stdout.trim()}\n`);

  if (d.platform === 'linux') {
    // 2a. Rootless: the server's user runs the containers (NFR-SEC-08).
    if (d.uid === 0) io.out('Warning: run the server as a regular user. Bot computers must run in rootless Podman (NFR-SEC-08).\n');
    else {
      const sub = d.readFile('/etc/subuid') ?? '';
      if (!new RegExp(`^${d.user.replace(/[^A-Za-z0-9_.-]/g, '')}:`, 'm').test(sub)) {
        if (!(await step(io, d, o, `Your user "${d.user}" needs subordinate IDs for rootless containers:`, ['sudo', 'usermod', '--add-subuids', '100000-165535', '--add-subgids', '100000-165535', d.user]))) return false;
        await d.run('podman', ['system', 'migrate']);
      }
    }
    const pasta = await d.run('podman', ['info', '--format', '{{.Host.Pasta.Executable}}']);
    if (pasta.code !== 0 || !pasta.stdout.trim()) {
      const cmd = await linuxInstall(d, 'passt');
      io.out('Podman has no pasta network ("passt" package). Without it Bot computers are less isolated from this host.\n');
      if (cmd) await step(io, d, o, 'This installs it:', cmd);
    }
    // 3a. Start at boot: lingering lets the user's services and containers run without a login.
    if (d.uid !== 0) {
      const linger = await d.run('loginctl', ['show-user', d.user, '--property=Linger']);
      if (!/Linger=yes/.test(linger.stdout)) await step(io, d, o, 'Let Bot computers start at boot, before you sign in:', ['sudo', 'loginctl', 'enable-linger', d.user]);
    }
  } else {
    // 2b. Windows (WSL2) and macOS run containers in a Podman machine VM.
    const list = await d.run('podman', ['machine', 'list', '--format', 'json']);
    let machines: { Name: string; Running: boolean }[] = [];
    try {
      machines = JSON.parse(list.stdout || '[]');
    } catch {
      machines = [];
    }
    if (machines.length === 0) {
      const cpus = Math.max(2, Math.floor(d.cpus / 2));
      const memory = Math.max(4096, Math.floor(d.memoryMb / 2 / 1024) * 1024);
      if (!(await step(io, d, o, `Create the Podman machine for Bot computers (${cpus} CPUs, ${memory / 1024} GB memory, 100 GB disk):`, ['podman', 'machine', 'init', '--cpus', String(cpus), '--memory', String(memory), '--disk-size', '100']))) return false;
    }
    if (!machines.some((m) => m.Running)) {
      if (!(await step(io, d, o, 'Start the Podman machine:', ['podman', 'machine', 'start']))) return false;
    }
    io.out('The server starts the Podman machine when it starts, while auto-start is on.\n');
  }

  // 4. Build the image locally (D-09, DL-003).
  const image = o.image ?? BOT_IMAGE;
  const dir = o.imageDir ?? defaultImageDir();
  if (!fs.existsSync(path.join(dir, 'Containerfile'))) {
    io.out(`The image source is missing at ${dir}.\n`);
    return false;
  }
  io.out(`Building the Bot computer image ${image}. This takes several minutes the first time.\n`);
  if ((await d.runLive('podman', ['build', '--pull=missing', '-t', image, dir])) !== 0) {
    io.out('The image build failed. See the output above.\n');
    return false;
  }

  // 5. The owner toggle for starting Bot computers with the server.
  const dbFile = path.join(cfg.dataDir, 'state.db');
  if (fs.existsSync(dbFile)) {
    const db = openDb(dbFile);
    try {
      setMeta(db, 'computer.autoStart', String(o.autoStart ?? true));
    } finally {
      db.close();
    }
  }
  io.out(`Bot computers are ready.${o.autoStart === false ? ' Auto-start is off; turn it on in Settings > Cloud computer.' : ''}\n`);
  return true;
}

export function systemDeps(): SetupDeps {
  // Imported lazily so tests never touch child processes.
  return {
    platform: process.platform,
    user: os.userInfo().username,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    cpus: os.cpus().length,
    memoryMb: Math.floor(os.totalmem() / 1024 / 1024),
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    run: async (cmd, args) => {
      const { spawn } = await import('node:child_process');
      return new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (b: Buffer) => (stdout += b));
        p.stderr.on('data', (b: Buffer) => (stderr += b));
        p.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
        p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
    },
    runLive: async (cmd, args) => {
      const { spawn } = await import('node:child_process');
      return new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: 'inherit', shell: false });
        p.on('error', () => resolve(-1));
        p.on('close', (code) => resolve(code ?? -1));
      });
    },
  };
}
