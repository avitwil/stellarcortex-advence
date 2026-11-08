// Verifies a signed manifest and, with --dir, every file it lists (NFR-SEC-10).
//   node scripts/release/verify.mjs --pub <key> out/server/manifest.json --dir out/server
import fs from 'node:fs';
import path from 'node:path';
import { args, sha256File, verify } from './lib.mjs';

const a = args(process.argv.slice(2));
const pub = a.pub ?? process.env.ADVENCE_RELEASE_PUBKEY;
const file = a._[0];
if (!pub || !file) {
  console.error('usage: verify.mjs --pub <public key> <manifest.json> [--dir <files>]');
  process.exit(2);
}
const bytes = fs.readFileSync(file);
if (!verify(pub, bytes, fs.readFileSync(`${file}.sig`, 'utf8'))) {
  console.error(`${file}: BAD SIGNATURE`);
  process.exit(1);
}
const m = JSON.parse(bytes.toString('utf8'));
let bad = 0;
if (a.dir) {
  for (const f of m.files) {
    const full = path.join(a.dir, f.name);
    const ok = fs.existsSync(full) && fs.statSync(full).size === f.size && sha256File(full) === f.sha256;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'} ${f.name}`);
  }
}
console.log(`${file}: signature ok (${m.component} ${m.version})`);
process.exit(bad ? 1 : 0);
