// Fills the feed URL and pinned release key(s) into the one-line installers (FR-CLI-06):
//   node scripts/release/render-installers.mjs --feed https://updates.example.org --keys <pub>[,<pub>] --out out
// The rendered install.sh and install.ps1 are published at the feed root next to server/.
import fs from 'node:fs';
import path from 'node:path';
import { args, repoRoot } from './lib.mjs';

const a = args(process.argv.slice(2));
if (!a.feed || !a.keys || !a.out) {
  console.error('usage: render-installers.mjs --feed <https url> --keys <base64url>[,...] --out <dir>');
  process.exit(2);
}
const feed = a.feed.replace(/\/+$/, '');
if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(feed) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[A-Za-z0-9._~\/-]*)?$/.test(feed)) throw new Error('feed must be a plain https URL');
const keys = a.keys.split(',').map((k) => k.trim()).filter(Boolean);
if (!keys.length || keys.some((k) => !/^[A-Za-z0-9_-]{43}$/.test(k))) throw new Error('keys must be base64url Ed25519 public keys');
fs.mkdirSync(a.out, { recursive: true });
for (const name of ['install.sh', 'install.ps1']) {
  const src = fs.readFileSync(path.join(repoRoot, 'install', name), 'utf8');
  const out = src.replaceAll('@FEED_URL@', feed).replaceAll('@RELEASE_KEYS@', keys.join(','));
  fs.writeFileSync(path.join(a.out, name), out, { mode: name.endsWith('.sh') ? 0o755 : 0o644 });
}
console.log(`installers written to ${a.out}`);
