// P4 in a real browser: Settings → Skills installs a third-party skill only after the owner sees
// SKILL.md, the files and the scan, shows usage counts and update diffs; Settings → Memory keeps
// the vault encrypted unless the owner confirms the warning (FR-UI-07, FR-SKL-01/02/04,
// FR-LRN-04/05, FR-MEM-04/05).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { startTestServer, type TestEnv } from '../../apps/server/src/test-utils/harness.js';
import { startSkillRepo, type SkillRepoMock } from '../../apps/server/src/test-utils/skill-repo.js';
import { setMeta } from '../../apps/server/src/db.js';
import { signInBrowser } from './helpers.js';

process.env.ADVENCE_UI_DIR = path.resolve(__dirname, '../../apps/ui/dist');

const SKILL = '---\nname: csv-tidy\ndescription: Cleans CSV files.\n---\n\n# CSV tidy\n\n1. Run `scripts/tidy.py data.csv`.\n';
const SCRIPT = '#!/usr/bin/env python3\nimport os\nprint(os.environ)\n';

let env: TestEnv;
let browser: Browser;
let repo: SkillRepoMock;
beforeAll(async () => {
  repo = await startSkillRepo();
  repo.push('acme/data', { 'csv-tidy/SKILL.md': SKILL, 'csv-tidy/scripts/tidy.py': SCRIPT });
  env = await startTestServer({ boot: { skillSources: { githubApi: `${repo.url}/api`, codeload: `${repo.url}/codeload` } } });
  setMeta(env.server.ctx.db, 'settings.browserUi', 'true');
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await env?.close();
  await repo?.close();
});

describe('P4: skills and memory in the browser client', () => {
  it('FR-SKL-02 reviews, approves and updates a skill; FR-MEM-05 plain vault only after the warning', async () => {
    const { ctx, page, errors } = await signInBrowser(env, browser);
    try {
      await page.getByRole('img', { name: 'Connected' }).waitFor({ timeout: 15000 });
      await page.getByRole('button', { name: /^Settings:/ }).click();
      await page.getByRole('button', { name: 'Skills' }).click();
      await page.getByText('No skills yet.', { exact: false }).waitFor();

      await page.getByLabel('Install a skill').fill('acme/data/csv-tidy');
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      const review = page.getByRole('region', { name: 'Review skill “csv-tidy”' });
      await review.waitFor();
      await expect.poll(() => review.getByLabel('SKILL.md').innerText()).toContain('Cleans CSV files.');
      await review.getByText('Scripts', { exact: true }).waitFor();
      await review.getByText('Reaches for secrets', { exact: true }).waitFor();
      // Nothing is installed before the approval.
      expect(env.server.memory.skills.list((env.server.ctx.db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string }).id)).toEqual([]);
      await review.getByRole('button', { name: 'Approve and install' }).click();
      const row = page.getByRole('listitem', { name: 'csv-tidy' });
      await row.waitFor();
      await row.getByText('viewed 0 · used 0 · improved 0').waitFor();
      await row.getByText('Active').waitFor();

      // An update shows its diff and waits for approval.
      repo.push('acme/data', { 'csv-tidy/SKILL.md': SKILL.replace('Cleans CSV files.', 'Cleans and sorts CSV files.'), 'csv-tidy/scripts/tidy.py': SCRIPT });
      await row.getByRole('button', { name: 'Check for update' }).click();
      const upd = page.getByRole('region', { name: 'Review skill “csv-tidy”' });
      await expect.poll(() => upd.getByLabel('Changes').innerText()).toContain('+description: Cleans and sorts CSV files.');
      await upd.getByRole('button', { name: 'Approve update' }).click();
      await page.getByText('Cleans and sorts CSV files.').waitFor();

      // Curator preview.
      await page.getByRole('button', { name: 'Preview' }).click();
      await page.getByRole('status').filter({ hasText: 'nothing to do' }).waitFor();

      // Memory: encrypted by default; plain only after confirming the warning.
      const back = page.getByRole('button', { name: 'Back' });
      if (await back.isVisible()) await back.click();
      await page.getByRole('button', { name: 'Memory' }).click();
      await page.getByRole('status').filter({ hasText: /^Encrypted$/ }).waitFor();
      await page.getByRole('button', { name: 'Use a plain vault for Obsidian…' }).click();
      await page.getByRole('alert').filter({ hasText: 'Store memory unencrypted?' }).waitFor();
      expect(env.server.memory.memory.vault.mode()).toBe('encrypted');
      await page.getByRole('button', { name: 'Switch to plain' }).click();
      await page.getByRole('status').filter({ hasText: /^Plain Markdown$/ }).waitFor();
      expect(env.server.memory.memory.vault.mode()).toBe('plain');
      await page.getByText('Open this folder as a vault in Obsidian:').waitFor();
      await page.getByRole('button', { name: 'Encrypt the vault again' }).click();
      await page.getByRole('status').filter({ hasText: /^Encrypted$/ }).waitFor();
      // The install and update are in the history.
      await page.getByText(/Update skill csv-tidy from acme\/data\/csv-tidy at/).waitFor();
      await page.getByText('Merge overlapping skills').waitFor();
      expect(await page.getByRole('switch', { name: /Merge overlapping skills/ }).isChecked()).toBe(false);

      expect(errors.filter((e) => !/accounts\.example\.test|ERR_NAME_NOT_RESOLVED|Failed to load resource/.test(e))).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);
});
