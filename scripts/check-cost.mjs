#!/usr/bin/env node
// NFR-COST-01 / C-04: every external host named in shipped code (apps, packages, installers,
// images, scripts, CI) must be listed as free in docs/cost-audit.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')
  .filter((f) => /^(apps|packages|install|images|scripts|\.github)\//.test(f))
  .filter((f) => !/(\.test\.|test-utils\/|\.md$|\.(png|jar|svg|ico|webp)$)/.test(f) && fs.existsSync(f));
const found = new Map();
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    const host = m[1].toLowerCase();
    if (host === 'localhost' || /^127\./.test(host)) continue;
    if (!found.has(host)) found.set(host, f);
  }
}
const rows = new Map();
for (const line of fs.readFileSync('docs/cost-audit.md', 'utf8').split('\n')) {
  const m = /^\|\s*([a-z0-9.-]+\.[a-z]{2,})\s*\|[^|]*\|\s*([^|]+?)\s*\|$/.exec(line);
  if (m) rows.set(m[1], m[2]);
}
const errors = [];
for (const [host, file] of found) {
  if (!rows.has(host)) errors.push(`${host} (in ${file}) is not in docs/cost-audit.md`);
}
for (const [host, cost] of rows) {
  if (!/^(Free|Not contacted)\b/.test(cost)) errors.push(`${host} is not free: ${cost}`);
}
if (errors.length) {
  console.error(`Cost audit failed:\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`Cost audit passed: ${found.size} external hosts, all free or never contacted.`);
