// Writes a release manifest for one component from a folder of built files:
//   node scripts/release/manifest.mjs --component server --version 1.0.0 --dir out/server --out out/server/server-manifest.json
// Server bundle names carry the platform and arch: advence-server-<version>-<platform>-<arch>.<ext>
import fs from 'node:fs';
import path from 'node:path';
import { args, sha256File } from './lib.mjs';

const a = args(process.argv.slice(2));
const { component, version, dir } = a;
if (!component || !version || !dir || !a.out) {
  console.error('usage: manifest.mjs --component server|desktop|android --version x.y.z --dir <files> --out <manifest.json> [--version-code n] [--runtime vX.Y.Z] [--notes file]');
  process.exit(2);
}
const files = fs.readdirSync(dir).filter((f) => !/manifest\.json(\.sig)?$/.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort().map((name) => {
  const full = path.join(dir, name);
  const m = /^advence-server-.+?-(linux|darwin|win32)-(x64|arm64)\.(tar\.gz|zip)$/.exec(name);
  return { name, ...(m ? { platform: m[1], arch: m[2] } : {}), sha256: sha256File(full), size: fs.statSync(full).size };
});
if (!files.length) throw new Error(`no files in ${dir}`);
const manifest = {
  product: 'stellarcortex-advence', component, version, ...(a['version-code'] ? { versionCode: Number(a['version-code']) } : {}),
  ...(component === 'server' ? { runtime: a.runtime ?? process.version } : {}),
  createdAt: new Date().toISOString(), notes: a.notes ? fs.readFileSync(a.notes, 'utf8').slice(0, 4000) : '', files,
};
fs.writeFileSync(a.out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${a.out}: ${files.length} file(s)`);
