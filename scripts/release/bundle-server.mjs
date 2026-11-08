// Builds the server release bundle for the machine it runs on (D-24, FR-CLI-06):
//   node scripts/release/bundle-server.mjs --version 1.0.0 --out out/server
// Output: out/server/advence-server-<version>-<platform>-<arch>.tar.gz with
//   build-info.json  version, pinned release key(s), feed URL, Android signing SHA-1
//   launcher.mjs     the service entry (apps/server/launcher)
//   server/          `pnpm deploy --prod` of @advence/server (dist + a flat production node_modules)
//   ui/dist/         the React UI, served only when the browser UI is turned on (D-16)
//   image/           the Bot computer image build context, built locally on the host (DL-003)
// Native modules (better-sqlite3) are per OS and CPU, so each bundle is built on its own OS.
// The pinned key comes from ADVENCE_RELEASE_PUBKEY (a public value); no secret is read here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { args, repoRoot } from './lib.mjs';

const a = args(process.argv.slice(2));
if (!a.version || !a.out || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(a.version)) {
  console.error('usage: bundle-server.mjs --version x.y.z --out <dir> [--skip-build]');
  process.exit(2);
}
const root = repoRoot;
const sh = (cmd, argv, cwd = root) => execFileSync(cmd, argv, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
const keys = (process.env.ADVENCE_RELEASE_PUBKEY ?? '').split(',').map((k) => k.trim()).filter(Boolean);
if (!keys.length) console.warn('warning: ADVENCE_RELEASE_PUBKEY is not set; this bundle cannot verify updates');

if (!a['skip-build']) {
  sh('pnpm', ['--filter', '@advence/protocol', 'build']);
  sh('pnpm', ['--filter', '@advence/server', 'build']);
  sh('pnpm', ['--filter', '@advence/ui', 'build']);
}
// pnpm deploy cannot link across drive letters on Windows (a C: temp folder with a D: checkout,
// as on hosted runners), so the staging folder goes on the checkout's drive there.
const sameDrive = path.parse(path.resolve(os.tmpdir())).root.toLowerCase() === path.parse(root).root.toLowerCase();
const tmpBase = sameDrive ? os.tmpdir() : path.join(path.dirname(root), '.advence-tmp');
fs.mkdirSync(tmpBase, { recursive: true });
const stage = fs.mkdtempSync(path.join(tmpBase, 'advence-bundle-'));
// A flat (hoisted) node_modules: pnpm's default layout is built from symlinks, which tar on
// Windows stores as copies, so packages there could not find their own dependencies.
sh('pnpm', ['--filter', '@advence/server', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', path.join(stage, 'server')]);
if (!fs.existsSync(path.join(stage, 'server', 'dist', 'main.js'))) throw new Error('server/dist/main.js missing from the deploy');
fs.cpSync(path.join(root, 'apps', 'ui', 'dist'), path.join(stage, 'ui', 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'images', 'bot-computer'), path.join(stage, 'image'), { recursive: true });
fs.copyFileSync(path.join(root, 'apps', 'server', 'launcher', 'launcher.mjs'), path.join(stage, 'launcher.mjs'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(stage, 'THIRD_PARTY_NOTICES.md'));
fs.writeFileSync(path.join(stage, 'build-info.json'), `${JSON.stringify({
  version: a.version,
  releaseKeys: keys,
  feedUrl: (process.env.ADVENCE_FEED_URL ?? '').replace(/\/+$/, ''),
  androidSha1: process.env.ADVENCE_ANDROID_SHA1 ?? '',
  runtime: process.version,
}, null, 2)}\n`);

fs.mkdirSync(a.out, { recursive: true });
const name = `advence-server-${a.version}-${process.platform}-${process.arch}.tar.gz`;
const file = path.resolve(a.out, name);
// bsdtar on Windows and macOS and GNU tar on Linux all read this format. On Windows the
// system bsdtar is used by full path: Git for Windows puts GNU tar first on PATH in bash steps,
// and GNU tar reads "D:\a\..." as a remote host:file and fails.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
sh(tar, ['-czf', file, '-C', stage, '.']);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`${file} (${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB)`);
