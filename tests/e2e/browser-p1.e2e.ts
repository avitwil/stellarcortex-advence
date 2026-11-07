// P1 exit criterion in a real browser: pairing (link) -> setup wizard -> Google login ->
// empty chat round-trip, against the real server over pinned TLS 1.3 (FR-CLI-03,
// FR-GGL-01/02, FR-UI-10, D-16).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { startTestServer, CLIENT_ID, type TestEnv } from '../../apps/server/src/test-utils/harness.js';
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

  it('pairs, sets up Google, signs in and round-trips a chat message', async () => {
    setMeta(env.server.ctx.db, 'settings.browserUi', 'true');
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const res = await page.goto(env.server.url + '/');
    expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
    await page.getByRole('heading', { name: 'Connect to your server' }).waitFor();

    const port = new URL(env.server.url).port;
    const link = env.server.ctx.identity.createPairingToken(null, `127.0.0.1:${port}`, 'E2E server').link;
    await page.getByLabel('Pairing link').fill(link);
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('heading', { name: 'Confirm this device' }).waitFor();
    const code = (await page.locator('.code-display').innerText()).trim();
    expect(code).toMatch(/^\d{6}$/);
    const pending = env.server.ctx.identity.pendingPairings();
    expect(pending.at(-1)?.code).toBe(code);
    env.server.ctx.identity.approvePairing(pending.at(-1)!.pairingId, code);

    await page.getByRole('heading', { name: 'Set up Google sign-in' }).waitFor({ timeout: 15000 });
    for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Client ID').fill(CLIENT_ID);
    await page.getByLabel('Client secret').fill('test-client-secret-1234');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    let captured = '';
    await ctx.route('https://accounts.example.test/**', (route) => {
      captured = route.request().url();
      return route.fulfill({ body: 'consent screen' });
    });
    const popupP = ctx.waitForEvent('page');
    await page.getByRole('button', { name: 'Sign in with Google' }).click();
    const popup = await popupP;
    await expect.poll(() => captured).not.toBe('');
    await popup.close();
    const authUrl = new URL(captured);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authUrl.searchParams.get('state')!;
    const gcode = await env.google.issueCode({ sub: 'e2e-owner', email: 'owner@example.com' });
    await page.getByLabel('Paste the address').fill(`http://localhost:47823/oauth/callback?state=${state}&code=${gcode}`);
    await page.getByRole('button', { name: 'Confirm' }).click();

    await page.getByRole('img', { name: 'Connected' }).waitFor({ timeout: 15000 });
    const box = page.getByLabel('Message StellarCortex…');
    await box.fill('hello from e2e');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Server replied: “hello from e2e”').waitFor();
    await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/p1-chat.png') });

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
