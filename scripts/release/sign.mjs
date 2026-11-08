// Signs a manifest (NFR-SEC-10): writes <manifest>.sig next to it.
//   ADVENCE_RELEASE_KEY=… node scripts/release/sign.mjs out/server/server-manifest.json
//   node scripts/release/sign.mjs --key-file ~/advence-release.key out/server/server-manifest.json
import fs from 'node:fs';
import { args, loadSeed, privateKeyFromSeed, publicKeyOf, sign, verify } from './lib.mjs';

const a = args(process.argv.slice(2));
const seed = loadSeed(a['key-file']);
const pub = publicKeyOf(privateKeyFromSeed(seed));
if (a.expect && a.expect !== pub) {
  console.error('This key does not match the pinned public key (--expect).');
  process.exit(1);
}
for (const file of a._) {
  const bytes = fs.readFileSync(file);
  const sig = sign(seed, bytes);
  if (!verify(pub, bytes, sig)) throw new Error('signature self-check failed');
  fs.writeFileSync(`${file}.sig`, `${sig}\n`);
  console.log(`signed ${file}`);
}
