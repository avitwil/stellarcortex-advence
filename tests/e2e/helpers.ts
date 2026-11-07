// Shared E2E steps: pair a browser, run the setup wizard and sign in with (mock) Google.
import { expect } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { CLIENT_ID, type TestEnv } from '../../apps/server/src/test-utils/harness.js';

export async function signInBrowser(env: TestEnv, browser: Browser, o: { email?: string; sub?: string } = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
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

  if (!env.server.ctx.google()) {
    await page.getByRole('heading', { name: 'Set up Google sign-in' }).waitFor({ timeout: 15000 });
    for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Client ID').fill(CLIENT_ID);
    await page.getByLabel('Client secret').fill('test-client-secret-1234');
    await page.getByRole('button', { name: 'Save and continue' }).click();
  }

  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 15000 });
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
  const gcode = await env.google.issueCode({ sub: o.sub ?? 'e2e-owner', email: o.email ?? 'owner@example.com' });
  await page.getByLabel('Paste the address').fill(`http://localhost:47823/oauth/callback?state=${state}&code=${gcode}`);
  await page.getByRole('button', { name: 'Confirm' }).click();
  return { ctx, page, errors };
}
