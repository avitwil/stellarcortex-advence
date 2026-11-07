// P3 against real rootless Podman and the real bot-computer image (CI job "bot-computer", run as
// a non-root user): isolation and escape attempts (NFR-SEC-08), Chromium's sandbox (FR-PC-04),
// enforced limits (FR-PC-05), persistence (FR-PC-03), a coding task through a real engine inside
// the container with a forwarded local model port, git and tests in the container (FR-CODE-01/02),
// and no keys in the image or the container's configuration (FR-CODE-05).
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, ownerClient, type TestClient, type TestEnv } from './test-utils/harness.js';
import { startEngineMock, type EngineMock } from './test-utils/engine-mock.js';
import { PodmanRuntime } from './computer/runtime.js';
import { containerName } from './computer/manager.js';
import { procAddr } from './computer/peer.js';

const IMAGE = process.env.ADVENCE_REAL_PODMAN_IMAGE;
const CANARY = 'sk-advence-ci-canary-7f3a9c2e1b';

let env: TestEnv;
let owner: TestClient;
let mock: EngineMock;
let botId = '';
let port = 0;

async function req(method: string, url: string, body?: unknown): Promise<any> {
  const r = await owner.request(method, url, body);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

async function until(f: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Runs a shell command in the Bot's computer as the Bot's user. */
async function sh(cmd: string, timeoutMs = 120_000): Promise<{ code: number; out: string; err: string }> {
  const run = env.server.computers.manager.exec(botId, ['bash', '-lc', cmd], { signal: AbortSignal.timeout(timeoutMs) });
  let out = '';
  for await (const l of run.lines) out += `${l}\n`;
  const { code, stderr } = await run.done;
  return { code, out: out.trim(), err: stderr };
}

function hostAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

describe.runIf(IMAGE)('P3 real Bot computer (rootless Podman)', () => {
  beforeAll(async () => {
    mock = await startEngineMock();
    // Listen on every interface, like a real install, so the LAN path is part of the escape test.
    env = await startTestServer({ host: '0.0.0.0', boot: { containerRuntime: new PodmanRuntime(), image: IMAGE } });
    port = Number(new URL(env.server.url).port);
    owner = await ownerClient(env);
    // The owner's local model server on the host loopback is forwarded into the computer (D-07a).
    const src = await req('POST', '/v1/sources', { kind: 'local', name: 'Mock', baseUrl: `${mock.url}/v1`, apiKey: CANARY });
    const t0 = Date.now();
    const b = await req('POST', '/v1/bots', { name: 'Real', sourceId: src.id, model: 'mock-model', engine: 'opencode', tools: ['code', 'computer'] });
    botId = b.id;
    try {
      await until(async () => (await req('GET', `/v1/bots/${b.id}/computer`)).state === 'running', 120_000);
    } catch (e) {
      console.error('computer state:', JSON.stringify(await req('GET', `/v1/bots/${b.id}/computer`)));
      console.error(env.logs.filter((l) => /computer|podman|warn|error/i.test(l)).slice(-30).join('\n'));
      throw e;
    }
    // FR-PC-01: running within 60 s once the image is cached.
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 180_000);
  afterAll(async () => {
    await env?.close();
    await mock?.close();
    spawnSync('sh', ['-c', 'podman rm -f $(podman ps -aq --filter label=advence.bot) >/dev/null 2>&1; true']);
  });

  it('NFR-SEC-08 runs as the non-root Bot user with no capabilities, no new privileges and seccomp on', async () => {
    expect((await sh('id -u')).out).toBe('1000');
    const st = (await sh("grep -E '^(Seccomp|NoNewPrivs|CapEff|CapBnd):' /proc/self/status")).out;
    expect(st).toMatch(/Seccomp:\s+2/);
    expect(st).toMatch(/NoNewPrivs:\s+1/);
    expect(st).toMatch(/CapEff:\s+0{16}/);
    expect(st).toMatch(/CapBnd:\s+0{16}/);
    // No set-uid way back to root.
    expect((await sh('su -c id root </dev/null >/dev/null 2>&1 && echo ESCAPED || echo blocked')).out).toBe('blocked');
  });

  it('NFR-SEC-08 has no Podman or Docker socket and no host mounts except its own volume', async () => {
    expect((await sh('find / -xdev \\( -name podman.sock -o -name docker.sock \\) 2>/dev/null; ls /run/podman /run/user/*/podman 2>/dev/null; true')).out).toBe('');
    const mounts = (await sh("awk '{print $5}' /proc/self/mountinfo | sort -u")).out.split('\n');
    const allowed = /^(\/|\/proc(\/.*)?|\/sys(\/.*)?|\/dev(\/.*)?|\/home\/bot|\/etc\/(hosts|hostname|resolv\.conf)|\/run\/\.containerenv|\/run\/secrets(\/.*)?|\/tmp)$/;
    expect(mounts.filter((m) => !allowed.test(m))).toEqual([]);
    // The host's home and data folders are not visible.
    expect((await sh(`test -e ${JSON.stringify(env.dataDir)} && echo visible || echo hidden`)).out).toBe('hidden');
  });

  it('NFR-SEC-08 cannot reach the server API on the host by any address, but reaches the internet and the forwarded model port', async () => {
    const targets = ['127.0.0.1', 'host.containers.internal', 'host.docker.internal', '10.0.2.2', '169.254.1.2', '169.254.1.1', ...hostAddresses()];
    const gwHex = (await sh("awk '$2 == \"00000000\" {print $3; exit}' /proc/net/route")).out;
    if (/^[0-9A-F]{8}$/i.test(gwHex)) targets.push(procAddr(`${gwHex}:0`).ip);
    // All probes run at once; unreachable addresses time out instead of refusing.
    const probes = targets.map((h) => `(c=$(curl -sk --connect-timeout 4 --max-time 6 -o /dev/null -w '%{http_code}' https://${h}:${port}/v1/server-info); echo "${h} $c") &`).join('\n');
    const r = await sh(`${probes}\nwait`, 60_000);
    const lines = r.out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(targets.length);
    for (const l of lines) expect(l, `reached the server via ${l.split(' ')[0]}`).not.toMatch(/ 200$/);
    expect((await sh('curl -sI --max-time 20 https://registry.npmjs.org/ -o /dev/null -w "%{http_code}"')).out).toMatch(/^[23]\d\d$/);
    const fwd = new URL(mock.url).port;
    expect((await sh(`curl -s --max-time 5 http://127.0.0.1:${fwd}/v1/models`)).out).toContain('mock-model');
  }, 120_000);

  it('FR-PC-05 limits are enforced by the cgroup', async () => {
    expect((await sh('cat /sys/fs/cgroup/cpu.max')).out).toBe('200000 100000');
    expect((await sh('cat /sys/fs/cgroup/memory.max')).out).toBe(String(3072 * 1024 * 1024));
    expect(Number((await sh('cat /sys/fs/cgroup/pids.max')).out)).toBe(4096);
  });

  it('FR-PC-04 Chromium runs with its sandbox on, without --no-sandbox', async () => {
    const flags = (await sh('grep -rlI -- "--no-sandbox" /usr/bin/chromium* /etc/chromium* /usr/lib/chromium* 2>/dev/null; true')).out;
    expect(flags).toBe('');
    const r = await sh('timeout 90 chromium --headless=new --no-first-run --disable-gpu --virtual-time-budget=5000 --dump-dom chrome://sandbox 2>/tmp/chromium.err', 120_000);
    const why = r.out ? '' : (await sh('tail -n 25 /tmp/chromium.err; unshare -Ur true && echo userns-ok || echo userns-denied; cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null; cat /proc/self/attr/current 2>/dev/null')).out;
    expect(r.out, why).toMatch(/You are adequately sandboxed/);
    expect(r.out).not.toMatch(/not adequately sandboxed/i);
  }, 150_000);

  it('FR-CODE-02 clones a repo, edits it, runs its tests and commits inside the computer', async () => {
    const r = await sh([
      'set -e', 'cd ~/workspace', 'rm -rf origin.git demo',
      'git init -q --bare -b main origin.git', 'git clone -q origin.git demo 2>/dev/null', 'cd demo',
      'git config user.email bot@advence.local', 'git config user.name Bot',
      "printf 'exports.add = (a, b) => a - b;\\n' > add.js",
      "printf \"const t = require('node:test'); const a = require('node:assert'); t.test('add', () => a.strictEqual(require('./add').add(2, 3), 5));\\n\" > add.test.js",
      'git add -A && git commit -qm init && git push -q origin HEAD:main',
      'if node --test >/dev/null 2>&1; then echo "unexpected pass"; exit 1; fi',
      "sed -i 's/a - b/a + b/' add.js", 'node --test 2>&1 | grep -q "pass 1"', 'python3 -c "print(2 + 3)"',
      'git commit -qam "fix add" && git push -q origin HEAD:main', 'git -C ../origin.git log --oneline | wc -l',
    ].join('\n'));
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n').pop()).toBe('2');
  });

  it('FR-CODE-01 a real engine runs a task in the computer through the code tool, with the model port forwarded', async () => {
    const conv = (await req('POST', '/v1/conversations/direct', { botId })).id;
    await req('POST', `/v1/conversations/${conv}/messages`, { text: 'please', clientId: `c-${Date.now()}` });
    await until(async () => {
      const list = await req('GET', `/v1/conversations/${conv}/messages`);
      return list[list.length - 1].author === 'bot' && list[list.length - 1].status !== 'streaming';
    }, 300_000);
    const list = await req('GET', `/v1/conversations/${conv}/messages`);
    const reply = list[list.length - 1];
    expect(reply.status, reply.error).toBe('done');
    expect(reply.text).toContain('Engine said:');
    expect((reply.steps ?? []).some((s: any) => s.kind === 'command' && s.title.includes('echo hi'))).toBe(true);
    expect((await sh('cat ~/workspace/a.txt')).out).toBe('hi');
  }, 320_000);

  it('FR-CODE-05 keys never reach the image layers or the container configuration', () => {
    const name = containerName(botId);
    const inspect = execFileSync('podman', ['container', 'inspect', name], { encoding: 'utf8' });
    expect(inspect).not.toContain(CANARY);
    const save = spawnSync('sh', ['-c', `podman image save ${IMAGE} | grep -a -c -E '${CANARY}|sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|sk-proj-[A-Za-z0-9_-]{20,}'`], { encoding: 'utf8', maxBuffer: 1 << 20 });
    expect(save.stdout.trim()).toBe('0');
  });

  it('FR-PC-03 the home volume keeps its data across stop and start', async () => {
    await sh('echo kept > ~/persist.txt');
    await req('POST', `/v1/bots/${botId}/computer/stop`, {});
    await req('POST', `/v1/bots/${botId}/computer/start`, {});
    await until(async () => (await req('GET', `/v1/bots/${botId}/computer`)).state === 'running', 60_000);
    expect((await sh('cat ~/persist.txt')).out).toBe('kept');
  }, 90_000);
});
