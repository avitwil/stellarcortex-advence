#!/usr/bin/env node
// `advence` command: serve (default), pair, admin, backup, restore, unlock, computer setup, version.
import { loadConfig, VERSION } from './config.js';
import { startServer } from './app.js';
import { ask } from './cli/prompt.js';
import { cmdComputerSetup, systemDeps } from './cli/computer-setup.js';
import { BUILD } from './build-info.js';
import { Updater } from './update/updater.js';
import { cmdPair, cmdAdminReset, cmdAdminDevices, cmdAdminRevoke, cmdBackup, cmdRestore, cmdUnlock, type CliIO } from './cli/commands.js';

const UPDATE_EXIT = 75;
const io: CliIO = { out: (s) => process.stdout.write(s), ask, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const USAGE = `Usage: advence <command>
  serve                 run the server (default)
  pair [--host h:port]  pair a new device (shows a QR code)
  admin reset           break-glass: reset owner and revoke all devices
  admin devices         list devices
  admin revoke <id>     revoke a device
  backup --out <file>   encrypted backup of master key + device registry
  restore --in <file>   restore a key backup into an empty data folder
  unlock                provide the unlock passphrase
  computer setup [--yes] [--no-autostart]
                        set up Podman and build the Bot computer image
  update check          look for a signed update on the update feed
  update apply          download, verify and stage it; the service restarts into it
  version
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd = 'serve', sub, ...rest] = argv;
  const cfg = loadConfig();
  switch (cmd) {
    case 'serve': {
      let closing = false;
      const stop = async (code: number) => {
        if (closing) return;
        closing = true;
        await s.close().catch(() => undefined);
        process.exit(code);
      };
      // D-24: once an update is staged the server exits with the launcher's restart code.
      const s = await startServer({ config: cfg, update: { restart: () => void stop(UPDATE_EXIT) } });
      process.on('SIGINT', () => void stop(0));
      process.on('SIGTERM', () => void stop(0));
      // NFR-REL-02: the launcher's health check; sent once the API answers.
      const health = await s.app.inject({ method: 'GET', url: '/v1/health' });
      if (health.statusCode === 200 && process.send) process.send({ type: 'ready', version: VERSION });
      return -1;
    }
    case 'update': {
      const root = process.env.ADVENCE_INSTALL_ROOT;
      const u = new Updater({ build: BUILD, dataDir: cfg.dataDir, installRoot: root ?? null, underLauncher: false });
      if (sub === 'check') {
        const st = await u.check();
        if (!st.enabled) io.out('Updates are not set up in this build.\n');
        else if (st.error) io.out(`Update check failed: ${st.error}\n`);
        else io.out(st.available ? `Update available: ${st.available.version} (running ${st.current})\n${st.available.notes}\n` : `Up to date (${st.current}).\n`);
        return st.error ? 1 : 0;
      }
      if (sub === 'apply') {
        if (!root) throw new Error('run this from the installed service (ADVENCE_INSTALL_ROOT is not set)');
        const v = await u.stage();
        io.out(`Staged ${v}. The running service switches to it within a minute, or at its next start; it rolls back by itself if the new version fails its health check.\n`);
        return 0;
      }
      io.out(USAGE);
      return 2;
    }
    case 'pair':
      return (await cmdPair(cfg, io, { host: flag(argv, '--host') })) ? 0 : 1;
    case 'admin':
      if (sub === 'reset') await cmdAdminReset(cfg, io);
      else if (sub === 'devices') cmdAdminDevices(cfg, io);
      else if (sub === 'revoke' && rest[0]) cmdAdminRevoke(cfg, io, rest[0]);
      else {
        io.out(USAGE);
        return 2;
      }
      return 0;
    case 'backup': {
      const out = flag(argv, '--out');
      if (!out) throw new Error('--out <file> is required');
      await cmdBackup(cfg, io, out);
      return 0;
    }
    case 'restore': {
      const inp = flag(argv, '--in');
      if (!inp) throw new Error('--in <file> is required');
      await cmdRestore(cfg, io, inp);
      return 0;
    }
    case 'unlock':
      await cmdUnlock(cfg, io);
      return 0;
    case 'computer':
      if (sub !== 'setup') {
        io.out(USAGE);
        return 2;
      }
      return (await cmdComputerSetup(cfg, io, systemDeps(), { yes: argv.includes('--yes'), autoStart: !argv.includes('--no-autostart') })) ? 0 : 1;
    case 'version':
      io.out(`${VERSION}\n`);
      return 0;
    default:
      io.out(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e: Error) => {
    process.stderr.write(`advence: ${e.message}\n`);
    process.exit(1);
  },
);
