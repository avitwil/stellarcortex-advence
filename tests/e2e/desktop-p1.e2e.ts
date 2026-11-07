// P1 exit on the desktop shell: the real Electron app (sandboxed renderer, pinned TLS via
// setCertificateVerifyProc, safeStorage key, loopback Google sign-in) pairs, signs in and
// round-trips a chat message with the real server (FR-CLI-03, FR-GGL-02, NFR-SEC-01/07).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { startTestServer, configureGoogle, pairedClient, type TestEnv } from '../../apps/server/src/test-utils/harness.js';
import { MockModels } from '../../apps/server/src/test-utils/mock-models.js';

const DESKTOP = path.resolve(__dirname, '../../apps/desktop');
let env: TestEnv;
let xvfb: ChildProcess | undefined;
let app: ElectronApplication | undefined;
let models: MockModels;

beforeAll(async () => {
  if (!process.env.DISPLAY) {
    xvfb = spawn('Xvfb', [':97', '-screen', '0', '1400x900x24', '-ac'], { stdio: 'ignore' });
    process.env.DISPLAY = ':97';
    await new Promise((r) => setTimeout(r, 800));
  }
  models = await MockModels.start();
  env = await startTestServer();
  // Google is configured by an earlier device so this run goes straight to sign-in.
  await configureGoogle(await pairedClient(env));
});
afterAll(async () => {
  // Bounded shutdown: if Electron does not quit in time, kill it.
  if (app) {
    const proc = app.process();
    await Promise.race([app.close().catch(() => undefined), new Promise((r) => setTimeout(r, 10_000))]);
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }
  await env?.close();
  await models?.close();
  xvfb?.kill();
});

describe('P1 exit: desktop (Electron) end to end', () => {
  it('rejects a server whose key does not match the pin, then pairs, signs in and chats', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-desktop-'));
    const asRoot = process.getuid?.() === 0;
    const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
    delete childEnv.NODE_OPTIONS;
    if (asRoot) {
      const uid = Number(process.env.E2E_UID ?? 999);
      fs.chownSync(userData, uid, Number(process.env.E2E_GID ?? 30001));
      Object.assign(childEnv, { E2E_UID: String(uid), E2E_GID: process.env.E2E_GID ?? '30001', HOME: userData });
    }
    app = await electron.launch({
      ...(asRoot ? { executablePath: path.resolve(__dirname, 'electron-as-user.sh') } : {}),
      args: [DESKTOP, `--user-data-dir=${userData}`, '--password-store=basic'],
      env: childEnv,
    });
    const page = await app.firstWindow();
    page.on('console', (m) => process.env.E2E_DEBUG && console.log('[renderer]', m.type(), m.text()));
    app.process().stderr?.on('data', (d) => process.env.E2E_DEBUG && console.log('[main]', String(d)));
    await page.getByRole('heading', { name: 'Connect to your server' }).waitFor({ timeout: 20000 });
    // renderer hardening (NFR-SEC-07)
    const hardening = await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process, bridge: typeof (window as any).advenceDesktop }));
    expect(hardening).toEqual({ require: 'undefined', process: 'undefined', bridge: 'object' });

    const port = new URL(env.server.url).port;
    // A link carrying a wrong pin must be blocked by the certificate verifier (MITM test).
    const good = env.server.ctx.identity.createPairingToken(null, `127.0.0.1:${port}`, 'Desktop E2E').link;
    const bad = good.replace(/k=[^&]+/, `k=${'A'.repeat(43)}`);
    await page.getByLabel('Pairing link').fill(bad);
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').innerText()).toContain('does not match');
    expect(env.server.ctx.identity.pendingPairings().length).toBe(0);

    const link = env.server.ctx.identity.createPairingToken(null, `127.0.0.1:${port}`, 'Desktop E2E').link;
    await page.getByLabel('Pairing link').fill(link);
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('heading', { name: 'Confirm this device' }).waitFor();
    const code = (await page.locator('.code-display').innerText()).trim();
    const p = env.server.ctx.identity.pendingPairings().at(-1)!;
    expect(p.platform).toBe('linux');
    env.server.ctx.identity.approvePairing(p.pairingId, code);

    await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Sign in with Google' }).click();
    let state = '';
    await expect.poll(() => (state = (env.server.ctx.db.prepare('SELECT state FROM oauth_states ORDER BY expires_at DESC LIMIT 1').get() as { state: string } | undefined)?.state ?? ''), { timeout: 10000 }).not.toBe('');
    const gcode = await env.google.issueCode({ sub: 'desk-owner', email: 'owner@example.com' });
    const cb = await fetch(`http://127.0.0.1:47823/oauth/callback?code=${gcode}&state=${state}`);
    expect(cb.status).toBe(200);

    await page.getByRole('img', { name: 'Connected' }).waitFor({ timeout: 20000 });
    // P2 exit on desktop: chat with a Bot through a model source (a local OpenAI-compatible server).
    const { id: uid } = env.server.ctx.db.prepare("SELECT id FROM users WHERE email = 'owner@example.com'").get() as { id: string };
    const user = env.server.ctx.identity.getUser(uid)!;
    const src = env.server.chat.sources.create(user, { kind: 'local', name: 'Mock', baseUrl: `${models.url}/v1` });
    const primary = env.server.chat.bots.list(user)[0]!;
    env.server.chat.bots.update(user, primary.id, { sourceId: src.id, model: 'mock-model-a' });
    await page.getByRole('button', { name: /Chief of Staff/ }).click();
    await page.getByLabel('Message Chief of Staff…').fill('hello desktop');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.md', { hasText: 'Echo: hello desktop' }).waitFor();
    await page.screenshot({ path: path.resolve(__dirname, '../../.tmp/p1-desktop.png') });
    // exactly one device key is stored (none kept for the blocked server)
    const files = fs.readdirSync(path.join(userData, 'secrets'));
    expect(files.length).toBe(1);
  });
});
