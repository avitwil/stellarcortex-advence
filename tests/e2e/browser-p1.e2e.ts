// P1 exit criterion in a real browser: pairing (link) -> setup wizard -> Google login ->
// empty chat round-trip, against the real server over pinned TLS 1.3 (FR-CLI-03,
// FR-GGL-01/02, FR-UI-10, D-16).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { startTestServer, type TestEnv } from '../../apps/server/src/test-utils/harness.js';
import { signInBrowser } from './helpers.js';
import { setMeta } from '../../apps/server/src/db.js';

process.env.ADVENCE_UI_DIR = path.resolve(__dirname, '../../apps/ui/dist');

let env: TestEnv;
let browser: Browser;
beforeAll(async () => {
  env = await startTestServer();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await env?.close();
});

describe('P1 exit: browser client end to end', () => {
  it('browser UI is off by default', async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const r = await ctx.request.get(env.server.url + '/');
    expect(r.status()).toBe(404);
    await ctx.close();
  });

  it('pairs, sets up Google, signs in and reaches the chat home', async () => {
    setMeta(env.server.ctx.db, 'settings.browserUi', 'true');
    const { ctx, page, errors } = await signInBrowser(env, browser);
    // The signed WebSocket is up and the home lists the primary Bot (FR-UI-01).
    await page.getByRole('img', { name: 'Connected' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: /Chief of Staff/ }).waitFor();
    await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/p1-home.png') });

    // FR-UI-10: switch to Hebrew at runtime; the document mirrors to RTL.
    await page.getByRole('button', { name: /^Settings:/ }).click();
    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('button', { name: 'עברית' }).click();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    await page.getByRole('heading', { name: 'שפה' }).waitFor();
    // light/dark themes
    await page.getByRole('button', { name: 'מראה' }).click();
    await page.getByRole('button', { name: 'בהירה' }).click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/p1-settings-he.png') });
    expect(errors.filter((e) => !/accounts\.example\.test|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e))).toEqual([]);
    await ctx.close();
  });
});
