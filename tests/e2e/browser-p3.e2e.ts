// P3 in a real browser: the Bot computer live view through the server's pinned WebSocket proxy
// and noVNC, view-only until take-over, input reaching the desktop only during take-over, hand
// back, and the Cloud computer settings (FR-UI-05, FR-PC-05, FR-PC-06, FR-UI-07).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { startTestServer, type TestEnv } from '../../apps/server/src/test-utils/harness.js';
import { FakeRuntime } from '../../apps/server/src/test-utils/fake-runtime.js';
import { setMeta } from '../../apps/server/src/db.js';
import { signInBrowser } from './helpers.js';

process.env.ADVENCE_UI_DIR = path.resolve(__dirname, '../../apps/ui/dist');
const shot = (name: string) => path.resolve(__dirname, `../../.tmp/${name}.png`);

let env: TestEnv;
let browser: Browser;
let rt: FakeRuntime;
beforeAll(async () => {
  rt = await FakeRuntime.start();
  rt.rfb = true;
  env = await startTestServer({ boot: { containerRuntime: rt } });
  setMeta(env.server.ctx.db, 'settings.browserUi', 'true');
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await env?.close();
  rt?.close();
});

describe('P3: Bot computer in the browser client', () => {
  it('FR-UI-05 watches the live desktop, takes over with mouse and keyboard, and hands back', async () => {
    const { ctx, page, errors } = await signInBrowser(env, browser);
    try {
      await page.getByRole('img', { name: 'Connected' }).waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: /Chief of Staff/ }).click();
      await page.getByRole('button', { name: 'Open the computer of Chief of Staff' }).click();
      const dlg = page.getByRole('dialog');
      await dlg.getByRole('heading', { name: 'Computer of Chief of Staff' }).waitFor();
      // The primary Bot's computer was created with the Bot (FR-PC-01); start it if needed.
      const start = dlg.getByRole('button', { name: 'Start' });
      if (await start.isVisible()) await start.click();
      await dlg.getByRole('status').filter({ hasText: 'Running' }).waitFor({ timeout: 15000 });

      // noVNC connects through the server proxy and draws the first frame.
      const canvas = dlg.locator('.vnc-screen canvas');
      await canvas.waitFor({ timeout: 15000 });
      await dlg.getByText('Connecting…').waitFor({ state: 'detached', timeout: 15000 });
      expect(rt.rfbClients).toBeGreaterThanOrEqual(1);
      await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(10);

      // View only: clicks and keys do not reach the Bot's desktop.
      await canvas.click();
      await page.keyboard.press('a');
      await page.waitForTimeout(500);
      expect(rt.rfbEvents).toHaveLength(0);

      // Take over: the server pauses the Bot's computer actions and input flows.
      await dlg.getByRole('button', { name: 'Take over' }).click();
      await dlg.getByRole('status').filter({ hasText: 'You have control' }).waitFor();
      const botId = (env.server.ctx.db.prepare('SELECT id FROM bots WHERE is_primary = 1').get() as { id: string }).id;
      expect(env.server.computers.manager.state(botId).takeover).toBe(true);
      await page.screenshot({ path: shot('p3-takeover') });
      await canvas.click({ position: { x: 20, y: 20 } });
      await page.keyboard.press('b');
      await expect.poll(() => rt.rfbEvents.filter((e) => e.type === 'pointer').length).toBeGreaterThan(0);
      await expect.poll(() => rt.rfbEvents.filter((e) => e.type === 'key').length).toBeGreaterThan(0);

      // Hand back.
      await dlg.getByRole('button', { name: 'Hand back' }).click();
      await dlg.getByRole('button', { name: 'Take over' }).waitFor();
      expect(env.server.computers.manager.state(botId).takeover).toBe(false);
      const before = rt.rfbEvents.length;
      await canvas.click();
      await page.waitForTimeout(500);
      expect(rt.rfbEvents.length).toBe(before);
      await dlg.getByRole('button', { name: 'Close' }).click();

      // Settings > Cloud computer shows the runtime and image, and saves default limits (FR-PC-05).
      await page.getByRole('button', { name: /^Settings:/ }).click();
      await page.getByRole('button', { name: 'Cloud computer' }).click();
      await page.getByText('Podman 5.4.0').waitFor();
      await page.getByRole('status').filter({ hasText: 'Ready' }).waitFor();
      await page.getByLabel('CPUs').fill('3');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect.poll(() => env.server.computers.manager.settings().then((s) => s.defaults.cpus)).toBe(3);

      expect(errors.filter((e) => !/accounts\.example\.test|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e))).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});
