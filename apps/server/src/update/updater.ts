// Server updates (D-24, FR-CLI-05, NFR-REL-02). The updater reads the signed manifest from the
// self-hosted feed, checks it against the release keys pinned in this build, downloads the bundle
// for this OS and CPU, checks its SHA-256 and size, and extracts it next to the running version.
// It then writes `pending.json` and asks the launcher to restart; the launcher backs up the
// database, starts the new version and rolls back when its health check fails.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions, ReleaseError, verifyRelease, type ReleaseFile, type ReleaseManifest } from '@advence/protocol';
import type { BuildInfo } from '../build-info.js';

const run = promisify(execFile);
const MANIFEST_MAX = 256 * 1024;
const DAY_MS = 24 * 3600_000;

export interface UpdateStatus {
  current: string;
  /** no feed or no pinned key in this build */
  enabled: boolean;
  /** running from an installed bundle under the launcher, so an update can be applied */
  canApply: boolean;
  available: { version: string; notes: string } | null;
  checkedAt: number | null;
  error: string | null;
  /** a version staged and waiting for the restart */
  staged: string | null;
  lastFailed: { version: string; from: string | null; at: string; reason: string } | null;
}

export interface UpdaterOptions {
  build: BuildInfo;
  dataDir: string;
  /** the install folder (launcher layout); null in a development checkout */
  installRoot: string | null;
  /** true when the launcher started this process and listens for the restart exit code */
  underLauncher: boolean;
  fetch?: typeof fetch;
  platform?: string;
  arch?: string;
  /** called once an update is staged; the server closes and exits with the launcher's code */
  restart?: () => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class UpdateError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

/** A literal loopback address or `localhost`; a DNS name that only starts with 127 is not one. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  if (net.isIP(h) === 4) return h.startsWith('127.');
  return net.isIP(h) === 6 && h === '::1';
}

function secureUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname));
  } catch {
    return false;
  }
}

/**
 * GET for the release bundle with node:http(s). fetch (undici) in Node.js 22 can throw an
 * uncaught assertion and end the process when the server closes the connection while the body
 * is paused by backpressure (a slow disk, a fast feed). Redirects are followed, at most five,
 * and never to plain http (except on loopback).
 */
export function download(url: string, signal: AbortSignal, hops = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (!secureUrl(url)) return reject(new UpdateError('feed_not_https'));
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).get(u, { signal }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (hops <= 0) return reject(new UpdateError('feed_unavailable', 'too many redirects'));
        return resolve(download(new URL(res.headers.location, u).href, signal, hops - 1));
      }
      if (status < 200 || status > 299) {
        res.resume();
        return reject(new UpdateError('feed_unavailable', `${status} from the update feed`));
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

export class Updater {
  private checkedAt: number | null = null;
  private error: string | null = null;
  private latest: ReleaseManifest | null = null;
  private busy: Promise<unknown> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private restarting = false;

  constructor(private o: UpdaterOptions) {}

  get enabled(): boolean {
    return Boolean(this.o.build.feedUrl && this.o.build.releaseKeys.length);
  }

  private feed(): string {
    const url = new URL(this.o.build.feedUrl);
    // The signature protects the bytes; https still hides what is installed, so plain http
    // is accepted only for a loopback feed (tests and a local mirror).
    if (!secureUrl(url.toString())) throw new UpdateError('feed_not_https');
    return url.toString().replace(/\/+$/, '');
  }

  status(): UpdateStatus {
    const root = this.o.installRoot;
    let staged: string | null = null;
    let lastFailed: UpdateStatus['lastFailed'] = null;
    if (root) {
      try {
        staged = (JSON.parse(fs.readFileSync(path.join(root, 'pending.json'), 'utf8')) as { version: string }).version;
      } catch {
        /* none */
      }
      try {
        lastFailed = JSON.parse(fs.readFileSync(path.join(root, 'update-failed.json'), 'utf8')) as UpdateStatus['lastFailed'];
      } catch {
        /* none */
      }
    }
    const newer = this.latest && compareVersions(this.latest.version, this.o.build.version) > 0 ? this.latest : null;
    return {
      current: this.o.build.version,
      enabled: this.enabled,
      canApply: Boolean(root && this.o.underLauncher && this.enabled),
      available: newer ? { version: newer.version, notes: newer.notes } : null,
      checkedAt: this.checkedAt,
      error: this.error,
      staged,
      lastFailed,
    };
  }

  private async get(url: string, timeoutMs: number): Promise<Response> {
    // GitHub release downloads redirect to GitHub's file host. Redirects are followed, but never
    // to plain http (except on loopback); the signature and hash protect the bytes either way.
    const res = await (this.o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (res.url && !secureUrl(res.url)) throw new UpdateError('feed_not_https');
    if (!res.ok) throw new UpdateError('feed_unavailable', `${res.status} from the update feed`);
    return res;
  }

  /** Reads at most `max` bytes; a longer answer (with or without a length header) is dropped. */
  private async bytes(res: Response, max: number): Promise<Uint8Array> {
    if (Number(res.headers.get('content-length') ?? 0) > max) throw new UpdateError('too_large');
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array();
    const out = new Uint8Array(max);
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > max) {
        await reader.cancel();
        throw new UpdateError('too_large');
      }
      out.set(value, size);
      size += value.length;
    }
    return out.slice(0, size);
  }

  /** Fetches and verifies the server manifest; nothing is trusted before the signature checks out. */
  async check(): Promise<UpdateStatus> {
    if (!this.enabled) return this.status();
    try {
      const base = this.feed();
      const [m, s] = await Promise.all([this.get(`${base}/server-manifest.json`, 30_000), this.get(`${base}/server-manifest.json.sig`, 30_000)]);
      const manifest = await this.bytes(m, MANIFEST_MAX);
      const sig = new TextDecoder().decode(await this.bytes(s, 1024));
      this.latest = verifyRelease(manifest, sig, this.o.build.releaseKeys, 'server');
      this.error = null;
    } catch (e) {
      this.latest = null;
      this.error = e instanceof ReleaseError || e instanceof UpdateError ? e.code : 'feed_unavailable';
      this.o.log?.('update check failed', { code: this.error });
    } finally {
      this.checkedAt = Date.now();
    }
    return this.status();
  }

  private fileFor(m: ReleaseManifest): ReleaseFile {
    const f = m.files.find((x) => x.platform === (this.o.platform ?? process.platform) && x.arch === (this.o.arch ?? process.arch));
    if (!f) throw new ReleaseError('no_file', `no ${process.platform}-${process.arch} bundle in ${m.version}`);
    return f;
  }

  /**
   * Downloads, checks and extracts the newest version, then marks it pending. The file is
   * hashed while it streams and is never extracted unless hash and size match the manifest.
   */
  async stage(): Promise<string> {
    const root = this.o.installRoot;
    if (!root) throw new UpdateError('not_service');
    if (this.busy) throw new UpdateError('busy');
    const job = (async () => {
      await this.check();
      if (this.error) throw new UpdateError(this.error);
      const m = this.latest;
      if (!m || compareVersions(m.version, this.o.build.version) <= 0) throw new UpdateError('up_to_date');
      // Native modules match one Node.js major; a new major comes with a fresh install.
      if (m.runtime && m.runtime.split('.')[0] !== process.version.split('.')[0]) throw new UpdateError('runtime_changed', `${m.version} needs Node.js ${m.runtime}; run the installer again`);
      const f = this.fileFor(m);
      const versions = path.join(root, 'versions');
      fs.mkdirSync(versions, { recursive: true });
      // A private folder per job, so a second apply (from a shell, say) cannot touch these files.
      const work = fs.mkdtempSync(path.join(versions, `.job-${m.version}-`));
      const bundle = path.join(work, 'bundle.tar.gz');
      const staging = path.join(work, 'staging');
      try {
        const res = await download(`${this.feed()}/${encodeURIComponent(f.name)}`, AbortSignal.timeout(15 * 60_000));
        const hash = createHash('sha256');
        let size = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length;
            if (size > f.size) return cb(new UpdateError('bad_hash', 'download is larger than the manifest says'));
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        await pipeline(res, meter, fs.createWriteStream(bundle, { mode: 0o600 }));
        if (size !== f.size || hash.digest('hex') !== f.sha256) throw new ReleaseError('bad_hash');
        // Hash the file on disk once more: that is what tar reads.
        const again = createHash('sha256');
        for await (const c of fs.createReadStream(bundle)) again.update(c as Buffer);
        if (again.digest('hex') !== f.sha256) throw new ReleaseError('bad_hash');
        fs.mkdirSync(staging);
        // tar ships with Linux, macOS and Windows 10+; the archive is already verified.
        await run('tar', ['-xzf', bundle, '-C', staging], { timeout: 10 * 60_000 });
        const info = JSON.parse(fs.readFileSync(path.join(staging, 'build-info.json'), 'utf8')) as { version?: string };
        if (info.version !== m.version || !fs.existsSync(path.join(staging, 'server', 'dist', 'main.js'))) throw new UpdateError('bad_bundle');
        const target = path.join(versions, m.version);
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(staging, target);
        const pending = { version: m.version, db: path.join(this.o.dataDir, 'state.db'), at: new Date().toISOString() };
        const tmp = path.join(root, `pending.json.tmp-${process.pid}`);
        fs.writeFileSync(tmp, `${JSON.stringify(pending)}\n`);
        fs.renameSync(tmp, path.join(root, 'pending.json'));
        this.o.log?.('update staged', { version: m.version });
        return m.version;
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    })();
    this.busy = job;
    try {
      return await job;
    } finally {
      this.busy = null;
    }
  }

  /** Stages the update and restarts into it (the launcher finishes the switch). */
  async apply(): Promise<string> {
    if (!this.o.underLauncher || !this.o.installRoot) throw new UpdateError('not_service');
    const v = await this.stage();
    this.requestRestart();
    return v;
  }

  private requestRestart(): void {
    if (this.restarting) return;
    this.restarting = true;
    setTimeout(() => this.o.restart?.(), 250).unref();
  }

  /**
   * Daily check, and a watch for an update staged by `advence update apply` from a shell, so the
   * running service restarts into it.
   */
  start(): void {
    if (this.enabled) {
      this.timers.push(setTimeout(() => void this.check(), 5 * 60_000));
      this.timers.push(setInterval(() => void this.check(), DAY_MS));
    }
    if (this.o.installRoot && this.o.underLauncher) {
      const file = path.join(this.o.installRoot, 'pending.json');
      this.timers.push(setInterval(() => {
        if (!this.busy && fs.existsSync(file)) this.requestRestart();
      }, 30_000));
    }
    for (const t of this.timers) t.unref();
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
