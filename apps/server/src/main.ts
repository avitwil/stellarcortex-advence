#!/usr/bin/env node
// `advence` command: serve (default), pair, admin, backup, restore, unlock, version.
import { loadConfig, VERSION } from './config.js';
import { startServer } from './app.js';
import { ask } from './cli/prompt.js';
import { cmdPair, cmdAdminReset, cmdAdminDevices, cmdAdminRevoke, cmdBackup, cmdRestore, cmdUnlock, type CliIO } from './cli/commands.js';

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
      const s = await startServer({ config: cfg });
      const stop = async () => {
        await s.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return -1;
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
