// Server updates (D-24, FR-CLI-05, NFR-REL-02). The updater reads the signed manifest from the
// self-hosted feed, checks it against the release keys pinned in this build, downloads the bundle
// for this OS and CPU, checks its SHA-256 and size, and extracts it next to the running version.
// It then writes `pending.json` and asks the launcher to restart; the launcher backs up the
// database, starts the new version and rolls back when its health check fails.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
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

const isLoopback = (h: string) => h === 'localhost' || h === '[::1]' || /^127\./.test(h);

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
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) throw new UpdateError('feed_not_https');
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
    const res = await (this.o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!res.ok) throw new UpdateError('feed_unavailable', `${res.status} from the update feed`);
    return res;
  }

  private async bytes(res: Response, max: number): Promise<Uint8Array> {
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > max) throw new UpdateError('too_large');
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > max) throw new UpdateError('too_large');
    return buf;
  }

  /** Fetches and verifies the server manifest; nothing is trusted before the signature checks out. */
  async check(): Promise<UpdateStatus> {
    if (!this.enabled) return this.status();
    try {
      const base = this.feed();
      const [m, s] = await Promise.all([this.get(`${base}/server/manifest.json`, 30_000), this.get(`${base}/server/manifest.json.sig`, 30_000)]);
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
      const download = path.join(versions, `.download-${m.version}`);
      const staging = path.join(versions, `.staging-${m.version}`);
      fs.rmSync(staging, { recursive: true, force: true });
      try {
        const res = await this.get(`${this.feed()}/server/${encodeURIComponent(f.name)}`, 15 * 60_000);
        if (!res.body) throw new UpdateError('feed_unavailable');
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
        await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), meter, fs.createWriteStream(download, { mode: 0o600 }));
        if (size !== f.size || hash.digest('hex') !== f.sha256) throw new ReleaseError('bad_hash');
        fs.mkdirSync(staging, { recursive: true });
        // tar ships with Linux, macOS and Windows 10+; the archive is already verified.
        await run('tar', ['-xzf', download, '-C', staging], { timeout: 10 * 60_000 });
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
        fs.rmSync(download, { force: true });
        fs.rmSync(staging, { recursive: true, force: true });
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
