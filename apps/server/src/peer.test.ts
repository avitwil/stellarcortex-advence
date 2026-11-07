// NFR-SEC-08: a connection opened by a container network helper on this host (what a Bot
// computer's traffic to the host's own address looks like under rootless Podman) is refused;
// other local and remote clients are not affected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestEnv } from './test-utils/harness.js';
import { canonicalIp, fromContainerNetwork, procAddr } from './computer/peer.js';

let env: TestEnv;
beforeAll(async () => {
  env = await startTestServer();
});
afterAll(async () => env.close());

const client = `
const https = require('node:https');
https.get(process.argv[1], { rejectUnauthorized: false }, (r) => { console.log('status', r.statusCode); r.resume(); })
  .on('error', (e) => console.log('error', e.code || e.message));
`;

/** Runs an https client whose process name is `name` (comm comes from the executable's name). */
async function runAs(name: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-peer-'));
  const bin = path.join(dir, name);
  fs.symlinkSync(process.execPath, bin);
  const p = spawn(bin, ['-e', client, `${env.server.url}/v1/server-info`], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 15_000 });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  await new Promise((r) => p.on('close', r));
  return out.trim();
}

describe('NFR-SEC-08 Bot computers cannot reach the server API', () => {
  it.runIf(process.platform === 'linux')('refuses a local connection owned by pasta or slirp4netns, and serves other local clients', async () => {
    expect(await runAs('node')).toBe('status 200');
    expect(await runAs('pasta')).toMatch(/^error /);
    expect(await runAs('slirp4netns')).toMatch(/^error /);
    expect(await runAs('node')).toBe('status 200');
    expect(env.logs.some((l) => l.includes('refused a connection from a Bot computer'))).toBe(true);
  });

  it('decodes /proc/net/tcp addresses and ignores non-Linux and remote peers', () => {
    expect(procAddr('0100007F:1F90')).toEqual({ ip: '127.0.0.1', port: 8080 });
    expect(procAddr('0000000000000000FFFF00000100007F:0050')).toEqual({ ip: '127.0.0.1', port: 80 });
    expect(procAddr('00000000000000000000000001000000:0016')).toEqual({ ip: '::1', port: 22 });
    expect(canonicalIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    const s = { remoteAddress: '127.0.0.1', remotePort: 1, localAddress: '127.0.0.1', localPort: 2 };
    expect(fromContainerNetwork(s, 'win32')).toBe(false);
    expect(fromContainerNetwork({ ...s, remoteAddress: '203.0.113.9' }, 'linux')).toBe(false);
  });
});
