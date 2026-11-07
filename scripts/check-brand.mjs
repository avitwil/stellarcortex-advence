#!/usr/bin/env node
// FR-UI-09 / C-05: third-party marks must never appear in the product, UI strings or
// assets. The forbidden words are decoded at runtime so this script does not match itself.
import fs from 'node:fs';
import path from 'node:path';

const words = ['R3Jvaw==', 'eEFJ', 'U3BhY2VY', 'Q3Vyc29y', 'SGFyaw=='].map((b) => Buffer.from(b, 'base64').toString());
const roots = ['apps', 'packages', 'images', 'scripts', 'README.md'];
const skipDirs = new Set(['node_modules', 'dist', 'dist-electron', 'release', 'build', '.gradle', '.vite', 'coverage']);
const exts = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.html', '.css', '.svg', '.md', '.xml', '.yml', '.yaml', '.sh', '.ps1', '.java', '.kt', '.gradle', '.txt', '.plist', '.desktop', '']);
// Product names are matched case-insensitively, except the two that are also ordinary
// lowercase words in code (the CSS `cursor` property, the verb "hark").
const [w0, w1, w2, w3, w4] = words;
const reCi = new RegExp(`\\b(${w0}|${w1}|${w2})\\b`, 'i');
const reCs = new RegExp(`\\b(${w3}|${w4})\\b`);
const re = { test: (l) => reCi.test(l) || reCs.test(l) };
const hits = [];
function walk(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    if (skipDirs.has(path.basename(p))) return;
    for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    return;
  }
  if (!exts.has(path.extname(p)) && !/\.(png|ico|icns)$/.test(p)) return;
  const text = fs.readFileSync(p, 'latin1');
  text.split('\n').forEach((line, i) => {
    if (re.test(line)) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
for (const r of roots) walk(r);
const real = hits;
if (real.length) {
  console.error(`Brand check failed (${real.length} hit(s)):\n` + real.join('\n'));
  process.exit(1);
}
console.log('Brand check passed: 0 hits.');
