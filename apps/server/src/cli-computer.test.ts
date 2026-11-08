// FR-PC-07: `advence computer setup` installs Podman from the official packages, prepares
// rootless use (sub-IDs, pasta, start at boot) or the Podman machine, builds the image and sets
// the auto-start toggle; the server starts the Podman machine on Windows and macOS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cmdComputerSetup, type SetupDeps } from './cli/computer-setup.js';
import { startTestServer, type TestEnv } from './test-utils/harness.js';
import { FakeRuntime } from './test-utils/fake-runtime.js';
import { getMeta } from './db.js';
import type { CliIO } from './cli/commands.js';

function fakeDeps(platform: NodeJS.Platform, o: { podman?: boolean; pasta?: boolean; subuid?: boolean; linger?: boolean; machines?: string; tools?: string[] } = {}) {
  const calls: string[] = [];
  let podman = o.podman ?? false;
  const d: SetupDeps = {
    platform, user: 'alice', uid: 1000, cpus: 8, memoryMb: 16384,
    readFile: (p) => (p === '/etc/subuid' ? (o.subuid ? 'alice:100000:65536\n' : 'bob:100000:65536\n') : null),
    async run(cmd, args) {
      const line = [cmd, ...args].join(' ');
      if (cmd === 'podman' && args[0] === '--version') return podman ? { code: 0, stdout: 'podman version 5.4.0\n', stderr: '' } : { code: 127, stdout: '', stderr: '' };
      if (cmd === 'podman' && args[0] === 'info') return { code: 0, stdout: o.pasta ? '/usr/bin/pasta\n' : '\n', stderr: '' };
      if (cmd === 'podman' && args[0] === 'machine' && args[1] === 'list') return { code: 0, stdout: o.machines ?? '[]', stderr: '' };
      if (cmd === 'loginctl') return { code: 0, stdout: o.linger ? 'Linger=yes\n' : 'Linger=no\n', stderr: '' };
      if (cmd === 'sh' || cmd === 'where') return { code: (o.tools ?? []).some((t) => line.includes(t)) ? 0 : 1, stdout: '', stderr: '' };
      calls.push(`run: ${line}`);
      return { code: 0, stdout: '', stderr: '' };
    },
    async runLive(cmd, args) {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      if (/install.*podman/i.test(line)) podman = true;
      return 0;
    },
  };
  return { d, calls };
}

const out: string[] = [];
const io: CliIO = { out: (s) => void out.push(s), ask: async () => 'y', sleep: async () => undefined };
const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-img-'));
fs.writeFileSync(path.join(imageDir, 'Containerfile'), 'FROM scratch\n');

let env: TestEnv;
let rt: FakeRuntime;
beforeAll(async () => {
  rt = await FakeRuntime.start();
  env = await startTestServer({ boot: { containerRuntime: rt } });
});
afterAll(async () => {
  await env.close();
  rt.close();
});

describe('FR-PC-07 computer setup', () => {
  it('Linux: installs rootless Podman with pasta, adds sub-IDs, enables lingering, builds the image and turns auto-start on', async () => {
    const { d, calls } = fakeDeps('linux', { tools: ['apt-get'] });
    const cfg = { ...env.server.ctx.config, dataDir: env.dataDir };
    expect(await cmdComputerSetup(cfg, io, d, { imageDir, image: 'localhost/advence-bot-computer:t' })).toBe(true);
    expect(calls).toEqual([
      'sudo apt-get install -y podman passt uidmap fuse-overlayfs',
      'sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 alice',
      'run: podman system migrate',
      'sudo apt-get install -y passt',
      'sudo loginctl enable-linger alice',
      `podman build --pull=missing -t localhost/advence-bot-computer:t ${imageDir}`,
    ]);
    expect(getMeta(env.server.ctx.db, 'computer.autoStart')).toBe('true');
  });

  it('Windows: installs Podman with winget, creates and starts the Podman machine on WSL2; the owner can leave auto-start off', async () => {
    const { d, calls } = fakeDeps('win32', { tools: ['winget'] });
    const cfg = { ...env.server.ctx.config, dataDir: env.dataDir };
    expect(await cmdComputerSetup(cfg, io, d, { imageDir, autoStart: false })).toBe(true);
    expect(calls[0]).toBe('winget install -e --id RedHat.Podman --accept-source-agreements --accept-package-agreements');
    expect(calls[1]).toBe('podman machine init --cpus 4 --memory 8192 --disk-size 100');
    expect(calls[2]).toBe('podman machine start');
    expect(calls[3]).toMatch(/^podman build /);
    expect(getMeta(env.server.ctx.db, 'computer.autoStart')).toBe('false');
  });

  it('macOS: uses Homebrew when present, otherwise points to the official download; a running machine is reused', async () => {
    const brew = fakeDeps('darwin', { tools: ['brew'], machines: '[{"Name":"podman-machine-default","Running":true}]' });
    expect(await cmdComputerSetup({ ...env.server.ctx.config, dataDir: env.dataDir }, io, brew.d, { imageDir })).toBe(true);
    expect(brew.calls).toEqual(['brew install podman', expect.stringMatching(/^podman build /)]);
    const none = fakeDeps('darwin');
    out.length = 0;
    expect(await cmdComputerSetup({ ...env.server.ctx.config, dataDir: env.dataDir }, io, none.d, { imageDir })).toBe(false);
    expect(out.join('')).toContain('https://podman.io/docs/installation');
    expect(none.calls).toEqual([]);
  });

  it('does nothing the user declines', async () => {
    const { d, calls } = fakeDeps('linux', { tools: ['apt-get'] });
    const no: CliIO = { ...io, ask: async () => 'n' };
    expect(await cmdComputerSetup({ ...env.server.ctx.config, dataDir: env.dataDir }, no, d, { imageDir })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('the server starts a stopped Podman machine on Windows and macOS while auto-start is on', async () => {
    const m = env.server.computers.manager;
    m.setSettings({ autoStart: true });
    rt.machineStopped = true;
    await m.init([], 'linux');
    expect(rt.machineStarts).toBe(0);
    await m.init([], 'win32');
    expect(rt.machineStarts).toBe(1);
    expect((await m.runtimeInfo()).available).toBe(true);
    m.setSettings({ autoStart: false });
    rt.machineStopped = true;
    await m.init([], 'darwin');
    expect(rt.machineStarts).toBe(1);
    rt.machineStopped = false;
  });
});
