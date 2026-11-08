// P7 server updates: signed feed checks (FR-CLI-05, NFR-SEC-10) and the launcher's atomic switch
// with rollback when the new version fails its health check (NFR-REL-02).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { releasePublicKey, signRelease } from '@advence/protocol';
import { Updater } from './update/updater.js';
import type { BuildInfo } from './build-info.js';
import { startTestServer, ownerClient, pairedClient, type TestEnv } from './test-utils/harness.js';
// @ts-expect-error plain JavaScript module without types
import { launch, UPDATE_EXIT } from '../launcher/launcher.mjs';

const seed = randomBytes(32);
const otherSeed = randomBytes(32);
const KEY = releasePublicKey(seed);
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `advence-${p}-`));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A static feed on loopback: path -> bytes. */
let files = new Map<string, Uint8Array>();
let feed: http.Server;
let feedUrl = '';

beforeAll(async () => {
  feed = http.createServer((req, res) => {
    const body = files.get(req.url ?? '');
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((r) => feed.listen(0, '127.0.0.1', r));
  feedUrl = `http://127.0.0.1:${(feed.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => feed.close(() => r())));
beforeEach(() => {
  files = new Map();
});

/**
 * A server bundle whose main.js is a stand-in: it sends the launcher's health signal (unless
 * told to fail) and writes to the database file, the way a schema migration would.
 */
function bundle(version: string, behaviour: 'good' | 'crash' | 'hang' | 'wrong-version' = 'good'): Uint8Array {
  const dir = tmp('bundle');
  fs.mkdirSync(path.join(dir, 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ version, releaseKeys: [KEY], feedUrl }));
  fs.copyFileSync(path.resolve(__dirname, '../launcher/launcher.mjs'), path.join(dir, 'launcher.mjs'));
  fs.writeFileSync(path.join(dir, 'server', 'dist', 'main.js'), mainJs(version, behaviour));
  const out = path.join(tmp('tgz'), 'b.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', dir, '.']);
  return fs.readFileSync(out);
}

function mainJs(version: string, behaviour: string): string {
  return `
const fs = require('node:fs'), path = require('node:path');
const root = process.env.ADVENCE_INSTALL_ROOT;
const db = path.join(root, 'data', 'state.db');
fs.appendFileSync(db, 'schema ${version}\\n');
fs.appendFileSync(path.join(root, 'runs.log'), '${version}\\n');
if (${JSON.stringify(behaviour)} === 'crash') process.exit(1);
if (${JSON.stringify(behaviour)} === 'hang') setInterval(() => {}, 1000);
else {
  process.send({ type: 'ready', version: ${JSON.stringify(behaviour)} === 'wrong-version' ? '9.9.9' : '${version}' });
  // A staged update makes the running version ask for the restart, like the real server.
  const pending = path.join(root, 'pending.json'), wait = path.join(root, 'wait');
  if (fs.existsSync(wait)) setInterval(() => { if (fs.existsSync(pending)) { fs.rmSync(wait); process.exit(75); } }, 50);
  else setTimeout(() => process.exit(fs.existsSync(pending) ? 75 : 0), 200);
}
`;
}

function publish(version: string, tgz: Uint8Array, o: { signWith?: Uint8Array; tamperManifest?: boolean; component?: string; fileBytes?: Uint8Array } = {}): void {
  const name = `advence-server-${version}-${process.platform}-${process.arch}.tar.gz`;
  const manifest = new TextEncoder().encode(JSON.stringify({
    product: 'stellarcortex-advence', component: o.component ?? 'server', version, createdAt: new Date().toISOString(), notes: `Release ${version}`,
    files: [{ name, platform: process.platform, arch: process.arch, sha256: sha(tgz), size: tgz.length }],
  }));
  const sig = signRelease(o.signWith ?? seed, manifest);
  const served = o.tamperManifest ? new TextEncoder().encode(new TextDecoder().decode(manifest).replace(`Release ${version}`, `Release ${version}!`)) : manifest;
  files.set('/server/manifest.json', served);
  files.set('/server/manifest.json.sig', new TextEncoder().encode(sig));
  files.set(`/server/${name}`, o.fileBytes ?? tgz);
}

function build(version = '1.0.0', keys = [KEY]): BuildInfo {
  return { version, releaseKeys: keys, feedUrl, androidSha1: '', bundled: true };
}

/** An install folder with version 1.0.0 in place, as the installer leaves it. */
function install(): { root: string; db: string } {
  const root = tmp('install');
  const v1 = path.join(root, 'versions', '1.0.0');
  fs.mkdirSync(path.join(v1, 'server', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(v1, 'server', 'dist', 'main.js'), mainJs('1.0.0', 'good'));
  fs.writeFileSync(path.join(root, 'current'), '1.0.0\n');
  fs.mkdirSync(path.join(root, 'data'));
  const db = path.join(root, 'data', 'state.db');
  fs.writeFileSync(db, 'original\n');
  return { root, db };
}

const updater = (root: string | null, b = build()) => new Updater({ build: b, dataDir: root ? path.join(root, 'data') : tmp('data'), installRoot: root, underLauncher: true });
const quiet = { log: () => undefined, signals: false, healthMs: 3000 };

describe('FR-CLI-05 / NFR-SEC-10: every update is signature-checked before it is applied', () => {
  it('finds a newer signed release and ignores an older or equal one', async () => {
    publish('1.1.0', bundle('1.1.0'));
    const st = await updater(null).check();
    expect(st.error).toBeNull();
    expect(st.available).toEqual({ version: '1.1.0', notes: 'Release 1.1.0' });
    publish('1.0.0', bundle('1.0.0'));
    expect((await updater(null).check()).available).toBeNull();
  });

  it('rejects a manifest signed by another key, an edited manifest and a manifest for another component', async () => {
    const { root } = install();
    for (const [o, code] of [[{ signWith: otherSeed }, 'bad_signature'], [{ tamperManifest: true }, 'bad_signature'], [{ component: 'desktop' }, 'wrong_component']] as const) {
      publish('1.1.0', bundle('1.1.0'), o);
      const u = updater(root);
      const st = await u.check();
      expect(st.error).toBe(code);
      expect(st.available).toBeNull();
      await expect(u.stage()).rejects.toMatchObject({ code });
      expect(fs.existsSync(path.join(root, 'versions', '1.1.0'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'pending.json'))).toBe(false);
    }
  });

  it('rejects a tampered bundle whose bytes do not match the signed hash, before extracting it', async () => {
    const { root } = install();
    const good = bundle('1.1.0');
    const evil = bundle('1.1.0', 'crash');
    publish('1.1.0', good, { fileBytes: evil });
    await expect(updater(root).stage()).rejects.toMatchObject({ code: 'bad_hash' });
    // a bundle padded beyond the signed size is cut off while it streams
    publish('1.1.0', good, { fileBytes: new Uint8Array([...good, ...new Uint8Array(4096)]) });
    await expect(updater(root).stage()).rejects.toMatchObject({ code: 'bad_hash' });
    expect(fs.readdirSync(path.join(root, 'versions'))).toEqual(['1.0.0']);
    expect(fs.existsSync(path.join(root, 'pending.json'))).toBe(false);
  });

  it('refuses when no release key is pinned, and refuses a plain-http feed that is not loopback', async () => {
    publish('1.1.0', bundle('1.1.0'));
    expect((await updater(null, build('1.0.0', [])).check()).enabled).toBe(false);
    const u = new Updater({ build: { ...build(), feedUrl: 'http://updates.example.com' }, dataDir: tmp('data'), installRoot: null, underLauncher: false });
    expect((await u.check()).error).toBe('feed_not_https');
  });

  it('stages a verified release: extracted next to the running version and marked pending', async () => {
    const { root, db } = install();
    publish('1.1.0', bundle('1.1.0'));
    expect(await updater(root).stage()).toBe('1.1.0');
    expect(fs.existsSync(path.join(root, 'versions', '1.1.0', 'server', 'dist', 'main.js'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'pending.json'), 'utf8'))).toMatchObject({ version: '1.1.0', db });
    expect(fs.readdirSync(path.join(root, 'versions')).sort()).toEqual(['1.0.0', '1.1.0']);
  });
});

describe('NFR-REL-02: updates are atomic with automatic rollback when the health check fails', () => {
  it('switches to a healthy new version and replaces the launcher', async () => {
    const { root, db } = install();
    publish('1.1.0', bundle('1.1.0'));
    await updater(root).stage();
    expect(await launch(root, quiet)).toBe(0);
    expect(fs.readFileSync(path.join(root, 'current'), 'utf8').trim()).toBe('1.1.0');
    expect(fs.existsSync(path.join(root, 'pending.json'))).toBe(false);
    expect(fs.readFileSync(db, 'utf8')).toBe('original\nschema 1.1.0\n');
    expect(fs.existsSync(path.join(root, 'launcher.mjs'))).toBe(true);
    expect(fs.readFileSync(`${db}.pre-1.1.0`, 'utf8')).toBe('original\n');
  });

  for (const behaviour of ['crash', 'hang', 'wrong-version'] as const) {
    it(`rolls back to the previous version and database when the new one fails (${behaviour})`, async () => {
      const { root, db } = install();
      fs.writeFileSync(`${db}-wal`, 'wal before');
      publish('1.1.0', bundle('1.1.0', behaviour));
      await updater(root).stage();
      const started = Date.now();
      expect(await launch(root, { ...quiet, healthMs: behaviour === 'hang' ? 800 : 3000 })).toBe(0);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(fs.readFileSync(path.join(root, 'current'), 'utf8').trim()).toBe('1.0.0');
      expect(fs.existsSync(path.join(root, 'pending.json'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'versions', '1.1.0'))).toBe(false);
      // the failed version's schema change is gone; the old version then ran on the restored file
      expect(fs.readFileSync(db, 'utf8')).toBe('original\nschema 1.0.0\n');
      expect(fs.readFileSync(`${db}-wal`, 'utf8')).toBe('wal before');
      expect(fs.readFileSync(path.join(root, 'runs.log'), 'utf8')).toBe('1.1.0\n1.0.0\n');
      const failed = JSON.parse(fs.readFileSync(path.join(root, 'update-failed.json'), 'utf8'));
      expect(failed).toMatchObject({ version: '1.1.0', from: '1.0.0' });
      expect(updater(root).status().lastFailed?.version).toBe('1.1.0');
    });
  }

  it('the running version restarts into an update staged while it runs (exit code 75)', async () => {
    const { root } = install();
    expect(UPDATE_EXIT).toBe(75);
    publish('1.1.0', bundle('1.1.0'));
    fs.writeFileSync(path.join(root, 'wait'), '');
    const done = launch(root, quiet);
    await new Promise((r) => setTimeout(r, 300));
    await updater(root).stage();
    expect(await done).toBe(0);
    expect(fs.readFileSync(path.join(root, 'runs.log'), 'utf8')).toBe('1.0.0\n1.1.0\n');
    expect(fs.readFileSync(path.join(root, 'current'), 'utf8').trim()).toBe('1.1.0');
  });

  it('ignores a pending file that names a version that is not there', async () => {
    const { root } = install();
    fs.writeFileSync(path.join(root, 'pending.json'), JSON.stringify({ version: '../../etc', db: '/tmp/x' }));
    expect(await launch(root, quiet)).toBe(0);
    expect(fs.readFileSync(path.join(root, 'current'), 'utf8').trim()).toBe('1.0.0');
    expect(fs.existsSync(path.join(root, 'pending.json'))).toBe(false);
  });
});

describe('FR-CLI-05: update routes', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startTestServer({ boot: { testHooks: { manualTriggers: true }, update: { build: build('1.0.0'), installRoot: null, underLauncher: false } } });
  });
  afterAll(() => env.close());

  it('owner sees the status and can check; apply needs an installed service; members are refused', async () => {
    publish('1.2.0', bundle('1.2.0'));
    const owner = await ownerClient(env);
    const st = await owner.request('GET', '/v1/update');
    expect(st.status).toBe(200);
    expect(st.json).toMatchObject({ current: '1.0.0', enabled: true, canApply: false });
    const ck = await owner.request('POST', '/v1/update/check');
    expect(ck.json.available.version).toBe('1.2.0');
    expect((await owner.request('POST', '/v1/update/apply')).json.error).toBe('not_service');
    await owner.request('POST', '/v1/allowlist', { email: 'member@example.com' });
    const member = await pairedClient(env, { approveAs: owner });
    expect((await member.loginWithCode(env.google, { sub: 'member-sub', email: 'member@example.com' })).status).toBe(200);
    expect((await member.request('GET', '/v1/update')).status).toBe(403);
    expect((await member.request('POST', '/v1/update/apply')).status).toBe(403);
  });
});
