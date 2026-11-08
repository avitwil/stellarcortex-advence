// Creates the Ed25519 release key (NFR-SEC-10). Run it once on the owner's own machine:
//   node scripts/release/keygen.mjs --out ~/advence-release.key
// The private key is written with mode 0600 and must never enter the repository or CI logs.
// Put its public key in the repository variable ADVENCE_RELEASE_PUBKEY; builds pin it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { args, privateKeyFromSeed, publicKeyOf, repoRoot } from './lib.mjs';

const a = args(process.argv.slice(2));
if (!a.out) {
  console.error('usage: node scripts/release/keygen.mjs --out <file outside the repository>');
  process.exit(2);
}
const out = path.resolve(a.out.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
if (out === repoRoot || out.startsWith(repoRoot + path.sep)) {
  console.error('Refusing to write the release key inside the repository.');
  process.exit(1);
}
if (fs.existsSync(out)) {
  console.error(`${out} already exists; refusing to overwrite a release key.`);
  process.exit(1);
}
const seed = crypto.randomBytes(32);
fs.writeFileSync(out, `${seed.toString('base64url')}\n`, { mode: 0o600 });
console.log(`Release key written to ${out} (keep it offline and backed up).`);
console.log(`Public key (set as ADVENCE_RELEASE_PUBKEY): ${publicKeyOf(privateKeyFromSeed(seed))}`);
