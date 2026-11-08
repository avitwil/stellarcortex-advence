import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer, TestClient, ownerClient, pairedClient } from './test-utils/harness.js';
import { cmdPair, cmdAdminReset, cmdBackup, cmdRestore, type CliIO } from './cli/commands.js';
import { readBackup } from './backup.js';

function io(answers: string[] = []): CliIO & { text: string } {
  const o = { text: '', out: (s: string) => void (o.text += s), ask: async () => answers.shift() ?? '', sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))) };
  return o;
}

describe('FR-CLI-03 `advence pair` on the server console', () => {
  it('prints a QR + link and approves the device after the typed code', async () => {
    const env = await startTestServer();
    const port = Number(new URL(env.server.url).port);
    const cfg = { ...env.server.ctx.config, port };
    const answers: string[] = [];
    const cio = io(answers);
    const pairing = cmdPair(cfg, cio, { host: `127.0.0.1:${port}`, timeoutMs: 10_000 });
    let link = '';
    for (let i = 0; i < 50 && !link; i++) {
      await new Promise((r) => setTimeout(r, 50));
      link = /advence:\/\/pair\?\S+/.exec(cio.text)?.[0] ?? '';
    }
    expect(cio.text).toMatch(/[▀▄█]/);
    const c = TestClient.fromLink(link, port);
    const { code } = await c.pair(link, 'Phone', 'android');
    answers.push(code);
    expect(await pairing).toBe(true);
    expect(env.server.ctx.identity.getDevice(c.deviceId)?.status).toBe('active');
    await env.close();
  });
});

describe('FR-GGL-07 break-glass admin', () => {
  it('resets owner and devices without Google, and recovery works', async () => {
    const env = await startTestServer();
    const owner = await ownerClient(env);
    expect((await owner.request('GET', '/v1/me')).status).toBe(200);
    const cio = io(['RESET']);
    await cmdAdminReset(env.server.ctx.config, cio);
    expect(cio.text).toMatch(/revoked/);
    expect((await owner.request('GET', '/v1/me')).status).toBe(403);
    expect(env.server.ctx.identity.hasOwner()).toBe(false);
    // recovery: pair a new device and sign in again; the first sign-in becomes owner
    const c = await pairedClient(env);
    const r = await c.request('POST', '/v1/auth/google/idtoken', { idToken: await env.google.idToken({ sub: 'new-owner', email: 'new@example.com' }) });
    expect(r.status).toBe(200);
    expect(r.json.user.role).toBe('owner');
    await env.close();
  });
  it('does nothing without confirmation', async () => {
    const env = await startTestServer();
    const owner = await ownerClient(env);
    await cmdAdminReset(env.server.ctx.config, io(['no']));
    expect((await owner.request('GET', '/v1/me')).status).toBe(200);
    await env.close();
  });
});

describe('NFR-SEC-05 encrypted key backup', () => {
  it('backs up and restores master key + device registry on a new server', async () => {
    const env = await startTestServer();
    const owner = await ownerClient(env);
    env.server.ctx.secrets.set('probe', 'probe-value-1');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'key-backup.json');
    await cmdBackup(env.server.ctx.config, io(), file, null, 'a very long passphrase');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(owner.deviceId);
    await expect(readBackup(JSON.parse(raw), 'wrong passphrase!!')).rejects.toThrow();
    const pin = env.server.ctx.tls.pin;
    await env.close();

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-new-'));
    const unlockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-unl-'));
    fs.rmSync(dataDir, { recursive: true });
    await cmdRestore({ ...env.server.ctx.config, dataDir, unlockDir }, io(), file, null, 'a very long passphrase');
    const env2 = await startTestServer({ dataDir, unlockDir, google: env.google });
    expect(env2.server.ctx.tls.pin).toBe(pin);
    // the restored device signs in again on the new server with its existing key
    owner.url = env2.server.url;
    owner.token = '';
    const rf = await owner.request('POST', '/v1/auth/refresh', {});
    expect(rf.status).toBe(200);
    expect(rf.json.user.role).toBe('owner');
    await env2.close();
  });
});
