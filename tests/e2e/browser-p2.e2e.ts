// P2 exit in a real browser: model sources, a Bot that streams markdown replies, the primary
// Bot's profile, a group chat with an @mention hand-off, threads, reactions, drafts, the
// Library, search, usage and Hebrew RTL (FR-UI-01..04, 07, 10, FR-BOT-01..05).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { startTestServer, type TestEnv } from '../../apps/server/src/test-utils/harness.js';
import { MockModels } from '../../apps/server/src/test-utils/mock-models.js';
import { setMeta } from '../../apps/server/src/db.js';
import { signInBrowser } from './helpers.js';

process.env.ADVENCE_UI_DIR = path.resolve(__dirname, '../../apps/ui/dist');
const shot = (name: string) => path.resolve(__dirname, `../../.tmp/${name}.png`);

let env: TestEnv;
let browser: Browser;
let models: MockModels;
beforeAll(async () => {
  models = await MockModels.start();
  env = await startTestServer();
  setMeta(env.server.ctx.db, 'settings.browserUi', 'true');
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await env?.close();
  await models?.close();
});

describe('P2 exit: chat with Bots in the browser client', () => {
  it('adds a model source, chats with a Bot, uses groups, threads, reactions, Library and search', async () => {
    const { ctx, page, errors } = await signInBrowser(env, browser);
    try {
    await page.getByRole('img', { name: 'Connected' }).waitFor({ timeout: 15000 });

    // Settings > Models and keys: add a local OpenAI-compatible server (FR-BOT-04).
    await page.getByRole('button', { name: /^Settings:/ }).click();
    await page.getByRole('button', { name: 'Models and keys' }).click();
    await page.getByRole('button', { name: 'Add model source' }).click();
    await page.getByLabel('Type').selectOption('local');
    await page.getByLabel('Name').fill('Home server');
    await page.getByLabel('Server address').fill(`${models.url}/v1`);
    await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click();
    await page.getByText('Home server').waitFor();
    // Subscription types show the personal-use notice (D-07c).
    await page.getByRole('button', { name: 'Add model source' }).click();
    await page.getByLabel('Type').selectOption('claude-subscription');
    await page.getByText(/personal use only/).first().waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Close' }).first().click();

    // The primary Bot: open its profile from the chat header and give it the source (FR-UI-03).
    await page.getByRole('button', { name: /Chief of Staff/ }).click();
    await page.getByRole('button', { name: 'Open the profile of Chief of Staff' }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.getByText('Proactive').waitFor();
    await dlg.getByText('Host control').waitFor();
    await dlg.getByRole('button', { name: 'Edit' }).click();
    await page.getByLabel('Model source').selectOption({ label: 'Home server (Local server)' });
    await page.getByRole('button', { name: 'Save' }).click();
    await dlg.getByText('Home server · Default model').waitFor();
    await page.screenshot({ path: shot('p2-profile') });
    await dlg.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => env.server.chat.bots.list(env.server.ctx.identity.getUser((env.server.ctx.db.prepare('SELECT id FROM users').get() as { id: string }).id)!)[0]!.sourceId).not.toBeNull();

    // Streaming markdown reply (FR-UI-02).
    models.script = () => ({ text: ['Here is **bold** and a list:\n\n', '- one\n- two\n\n', 'See [docs](https://example.com/guide.pdf).'], usage: { input: 12, output: 30, cost: 0.001 } });
    await page.getByLabel('Message Chief of Staff…').fill('hello bot');
    await page.keyboard.press('Enter');
    await page.locator('.md strong', { hasText: 'bold' }).waitFor();
    await page.locator('.md li', { hasText: 'two' }).waitFor();
    // Reactions and threads.
    const reply = page.locator('.msg.bot').last();
    await reply.hover();
    await reply.getByRole('button', { name: 'Add reaction' }).click();
    await page.getByRole('menuitem', { name: '👍' }).click();
    await reply.getByRole('button', { name: '👍 1' }).waitFor();
    models.script = () => ({ text: ['Thread answer'] });
    await reply.getByRole('button', { name: 'Reply in thread' }).click();
    await page.getByRole('complementary', { name: 'Thread' }).getByRole('textbox').fill('in a thread');
    await page.getByRole('complementary', { name: 'Thread' }).getByRole('button', { name: 'Send' }).click();
    await page.getByRole('complementary', { name: 'Thread' }).getByText('Thread answer').waitFor();
    await page.screenshot({ path: shot('p2-chat') });
    await page.getByRole('complementary', { name: 'Thread' }).getByRole('button', { name: 'Close' }).click();

    // A draft survives a reload (FR-UI-02).
    await page.getByLabel('Message Chief of Staff…').fill('unsent draft text');
    await page.waitForTimeout(900);
    await page.reload();
    await page.getByRole('button', { name: /Chief of Staff/ }).click();
    await expect.poll(() => page.getByLabel('Message Chief of Staff…').inputValue()).toBe('unsent draft text');
    await page.getByLabel('Message Chief of Staff…').fill('');

    // New Bot and a group chat with an @mention hand-off (FR-BOT-01, FR-BOT-03).
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New Bot' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Writer');
    await page.getByLabel('Model source').selectOption({ label: 'Home server (Local server)' });
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByLabel('Message Writer…').waitFor();
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New group chat' }).click();
    await page.getByLabel('Name').fill('Launch team');
    await page.getByRole('dialog').getByText('Chief of Staff').click();
    await page.getByRole('dialog').getByText('Writer').click();
    await page.getByRole('button', { name: 'Create' }).click();
    models.script = (r) => ((r.body.messages[0].content as string).includes('"Chief of Staff"')
      ? { text: ['Plan done. @Writer please draft the post.'] }
      : { text: ['Draft ready.'] });
    const box = page.getByLabel('Message Launch team…');
    await box.fill('@Chi');
    await page.getByRole('option', { name: /Chief of Staff/ }).click();
    await box.press('End');
    await box.type('plan the launch');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.md', { hasText: 'Draft ready.' }).waitFor();
    await page.screenshot({ path: shot('p2-group') });

    // Library and search (FR-UI-04, FR-UI-01).
    await page.getByRole('button', { name: 'Library' }).click();
    await page.locator('main .list-row', { hasText: 'docs' }).waitFor();
    await page.getByRole('searchbox', { name: 'Search' }).fill('launch');
    await page.locator('.sidebar-section').getByText('Launch team').first().waitFor();
    await page.getByRole('searchbox', { name: 'Search' }).fill('');

    // Usage (FR-BOT-05) and Hebrew RTL (FR-UI-10).
    await page.getByRole('button', { name: /^Settings:/ }).click();
    await page.getByRole('button', { name: 'Usage' }).click();
    await page.getByRole('cell', { name: '$0.001' }).waitFor();
    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('button', { name: 'עברית' }).click();
    await page.getByRole('button', { name: 'סגירה' }).first().click();
    await page.getByRole('button', { name: /Launch team/ }).click();
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    await page.screenshot({ path: shot('p2-group-he') });

    // Narrow screens: the list becomes a stack (FR-UI-08).
    await page.setViewportSize({ width: 390, height: 800 });
    await page.getByRole('button', { name: 'חזרה' }).first().click();
    await page.screenshot({ path: shot('p2-mobile-home-he') });
    expect(errors.filter((e) => !/accounts\.example\.test|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e))).toEqual([]);
    } catch (e) {
      await page.screenshot({ path: shot('p2-failure') });
      throw new Error(`${(e as Error).message}\nconsole errors: ${errors.join(' | ')}`);
    } finally {
      await ctx.close();
    }
  });
});
