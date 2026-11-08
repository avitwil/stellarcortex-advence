// Renders the product logo (apps/ui/public/logo.svg) into the PNG icons used by the desktop
// and Android shells, so every shipped icon comes from our own artwork (C-05).
// Usage: node scripts/render-icons.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'apps/ui/public/logo.svg'), 'utf8');
const BG = '#0d0f17';
// The mark alone (no rounded background), for adaptive-icon foregrounds and the splash.
const mark = svg.replace(/<rect[^>]*\/>/, '');

const res = join(root, 'apps/android/android/app/src/main/res');
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(file, size, html) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${html}</body></html>`,
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await page.screenshot({ omitBackground: true, type: 'png' }));
}
const full = (s) => svg.replace('<svg ', `<svg width="${s}" height="${s}" `);
const padded = (s, inner, bg) =>
  `<div style="width:${s}px;height:${s}px;display:flex;align-items:center;justify-content:center;background:${bg}">${mark.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div>`;

await render(join(root, 'apps/desktop/build/icon.png'), 512, full(512));
for (const [d, k] of Object.entries(densities)) {
  const dir = join(res, `mipmap-${d}`);
  await render(join(dir, 'ic_launcher.png'), 48 * k, full(48 * k));
  await render(
    join(dir, 'ic_launcher_round.png'),
    48 * k,
    `<div style="width:${48 * k}px;height:${48 * k}px;border-radius:50%;overflow:hidden">${padded(48 * k, 40 * k, BG)}</div>`,
  );
  // Adaptive icon: 108dp canvas, mark inside the 66dp safe zone.
  await render(join(dir, 'ic_launcher_foreground.png'), 108 * k, padded(108 * k, 66 * k, 'transparent'));
}
// One splash drawable instead of the template's per-orientation set.
for (const name of readdirSync(res)) {
  if (/^drawable-(land|port)-/.test(name)) rmSync(join(res, name), { recursive: true });
}
await render(join(res, 'drawable/splash.png'), 480, padded(480, 160, BG));
await browser.close();
console.log('icons rendered');
