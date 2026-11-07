// Bot computers (D-09, FR-PC-01..08, FR-UI-05): one rootless Podman container per Bot from
// images/bot-computer, a persistent home volume, resource limits, optional GPU, a network
// policy that cuts the container off from the host, and owner take-over of the desktop.
// Chat never depends on any of this (FR-PC-06): every failure only changes the computer state.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPUTER_EVENTS, type ComputerLimits, type ComputerSettings, type ComputerState, type ComputerStateKind } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { getMeta, setMeta } from '../db.js';
import { HttpError } from '../http.js';
import { botVolume, BOT_IMAGE, type ProcessRun } from '../models/host.js';
import { networkArgs, type ContainerRuntime, type ExecOptions, type RuntimeInfo } from './runtime.js';

export const DEFAULT_LIMITS: ComputerLimits = { cpus: 2, memoryMb: 3072, diskGb: 20 };
const DISK_CHECK_MS = 5 * 60_000;
const START_TIMEOUT_MS = 60_000;

export function containerName(botId: string): string {
  return `advence-bot-${botId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}
const vncSecretName = (botId: string) => `${containerName(botId)}-vnc`;
const vncKey = (botId: string) => `vnc:${botId}`;

export function defaultImageDir(): string {
  if (process.env.ADVENCE_IMAGE_DIR) return path.resolve(process.env.ADVENCE_IMAGE_DIR);
  // apps/server/{src,dist}/computer -> repository root -> images/bot-computer
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../images/bot-computer');
}

interface Live { state: ComputerStateKind; progress: number | null; detail: string | null }
interface BotRef { id: string; userId: string }

export class ComputerManager {
  private live = new Map<string, Live>();
  private pending = new Map<string, Promise<string>>();
  private takeovers = new Map<string, { release: () => void; done: Promise<void> }>();
  private info: RuntimeInfo | null = null;
  private gpuPresent = false;
  private image: { building: boolean; progress: number | null; error: string | null; present: boolean } = { building: false, progress: null, error: null, present: false };
  private imageJob: Promise<void> | null = null;
  private ac = new AbortController();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private ctx: AppContext,
    readonly runtime: ContainerRuntime,
    private o: { imageDir?: string; image?: string; serverPort?: number } = {},
  ) {}

  get imageName(): string {
    return this.o.image ?? BOT_IMAGE;
  }

  // ---------------------------------------------------------------- settings (FR-PC-05, FR-PC-07)
  autoStart(): boolean {
    return getMeta(this.ctx.db, 'computer.autoStart') !== 'false';
  }

  defaults(): ComputerLimits {
    const raw = getMeta(this.ctx.db, 'computer.defaults');
    return raw ? { ...DEFAULT_LIMITS, ...(JSON.parse(raw) as Partial<ComputerLimits>) } : DEFAULT_LIMITS;
  }

  async settings(): Promise<ComputerSettings> {
    const info = await this.runtimeInfo();
    return {
      runtime: { available: info.available, version: info.version, error: info.error },
      image: { ...this.image },
      autoStart: this.autoStart(),
      defaults: this.defaults(),
      gpu: this.gpuPresent,
      hostIsolated: networkArgs(info, []).isolated,
    };
  }

  setSettings(p: { autoStart?: boolean; defaults?: Partial<ComputerLimits> }): void {
    if (p.autoStart !== undefined) setMeta(this.ctx.db, 'computer.autoStart', String(p.autoStart));
    if (p.defaults) setMeta(this.ctx.db, 'computer.defaults', JSON.stringify({ ...this.defaults(), ...p.defaults }));
  }

  limits(botId: string): ComputerLimits {
    const r = this.ctx.db.prepare('SELECT cpus, memory_mb, disk_gb FROM computers WHERE bot_id = ?').get(botId) as { cpus: number | null; memory_mb: number | null; disk_gb: number | null } | undefined;
    const d = this.defaults();
    return { cpus: r?.cpus ?? d.cpus, memoryMb: r?.memory_mb ?? d.memoryMb, diskGb: r?.disk_gb ?? d.diskGb };
  }

  private row(botId: string): void {
    this.ctx.db.prepare('INSERT INTO computers(bot_id, created_at) VALUES(?,?) ON CONFLICT(bot_id) DO NOTHING').run(botId, Date.now());
  }

  /** Per-Bot limits; a running computer is restarted with them. Raising the disk limit clears "disk full". */
  async setLimits(bot: BotRef, p: Partial<ComputerLimits>): Promise<ComputerState> {
    this.row(bot.id);
    const cur = this.limits(bot.id);
    const next = { ...cur, ...p };
    this.ctx.db.prepare('UPDATE computers SET cpus = ?, memory_mb = ?, disk_gb = ?, disk_full = 0 WHERE bot_id = ?').run(next.cpus, next.memoryMb, next.diskGb, bot.id);
    const info = await this.runtime.inspect(containerName(bot.id)).catch(() => null);
    if (info?.running) {
      await this.runtime.remove(containerName(bot.id));
      void this.ensure(bot).catch(() => undefined);
    } else if (this.get(bot.id).state === 'disk_full') this.set(bot, { state: 'stopped', progress: null, detail: null });
    return this.state(bot.id);
  }

  // ---------------------------------------------------------------- state
  private get(botId: string): Live {
    return this.live.get(botId) ?? { state: 'stopped', progress: null, detail: null };
  }

  state(botId: string): ComputerState {
    const l = this.get(botId);
    const unavailable = this.info && !this.info.available;
    return {
      botId,
      state: unavailable ? 'unavailable' : l.state,
      progress: l.progress,
      detail: unavailable ? this.info!.error : l.detail,
      takeover: this.takeovers.has(botId),
      gpu: this.gpuPresent,
      limits: this.limits(botId),
    };
  }

  private set(bot: BotRef, l: Live): void {
    this.live.set(bot.id, l);
    this.ctx.bus.publish(bot.userId, COMPUTER_EVENTS.computerUpdated, this.state(bot.id));
  }

  async runtimeInfo(refresh = false): Promise<RuntimeInfo> {
    if (!this.info || refresh || !this.info.available) {
      this.info = await this.runtime.info().catch((e: Error) => ({ available: false, version: null, error: e.message, rootless: false, pasta: false }));
      if (this.info.available) this.gpuPresent = await this.runtime.gpu().catch(() => false);
    }
    return this.info;
  }

  // ---------------------------------------------------------------- lifecycle
  /** Starts the computers of all Bots when auto-start is on, and the disk watchdog. */
  async init(bots: BotRef[]): Promise<void> {
    const info = await this.runtimeInfo(true);
    this.image.present = info.available && (await this.runtime.imageExists(this.imageName).catch(() => false));
    if (this.ac.signal.aborted) return;
    this.timer = setInterval(() => void this.checkDisks(), DISK_CHECK_MS);
    this.timer.unref();
    if (!info.available) {
      this.ctx.log.warn({ error: info.error }, 'no container runtime: Bot computers are unavailable, chat still works');
      return;
    }
    if (!this.autoStart()) return;
    for (const b of bots) void this.ensure(b).catch((e: Error) => this.ctx.log.warn({ bot: b.id, err: e.message }, 'computer did not start'));
  }

  /** Builds the image once when it is missing; progress is shown on every waiting computer. */
  buildImage(force = false, onProgress?: (p: number) => void): Promise<void> {
    if (this.imageJob) return this.imageJob;
    this.imageJob = (async () => {
      if (!force && (await this.runtime.imageExists(this.imageName))) {
        this.image = { building: false, progress: null, error: null, present: true };
        return;
      }
      this.image = { building: true, progress: 0, error: null, present: false };
      this.ctx.bus.publish('*', COMPUTER_EVENTS.computerUpdated, { image: this.image });
      try {
        await this.runtime.buildImage(this.o.imageDir ?? defaultImageDir(), this.imageName, (p) => {
          this.image.progress = p;
          onProgress?.(p);
        }, this.ac.signal);
        this.image = { building: false, progress: null, error: null, present: true };
      } catch (e) {
        this.image = { building: false, progress: null, error: 'image_build_failed', present: false };
        this.ctx.log.error({ err: (e as Error).message }, 'bot computer image build failed');
        throw new HttpError(503, 'image_build_failed');
      } finally {
        this.ctx.bus.publish('*', COMPUTER_EVENTS.computerUpdated, { image: this.image });
      }
    })().finally(() => {
      this.imageJob = null;
    });
    return this.imageJob;
  }

  /** Loopback ports of the owner's local model servers, forwarded into the container (D-07a). */
  private forwards(userId: string): number[] {
    const rows = this.ctx.db.prepare("SELECT base_url FROM model_sources WHERE user_id = ? AND kind = 'local' AND base_url IS NOT NULL").all(userId) as { base_url: string }[];
    const ports = new Set<number>();
    for (const r of rows) {
      try {
        const u = new URL(r.base_url);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) continue;
        const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
        // The server's own port is never reachable from a container (NFR-SEC-08).
        if (port !== (this.o.serverPort ?? this.ctx.config.port)) ports.add(port);
      } catch {
        /* skip */
      }
    }
    return [...ports].sort((a, b) => a - b);
  }

  /** Creates (or re-creates after a settings change) and starts the Bot's computer. */
  ensure(bot: BotRef): Promise<string> {
    const p = this.pending.get(bot.id);
    if (p) return p;
    const job = this.doEnsure(bot).finally(() => this.pending.delete(bot.id));
    this.pending.set(bot.id, job);
    return job;
  }

  private async doEnsure(bot: BotRef): Promise<string> {
    const name = containerName(bot.id);
    const info = await this.runtimeInfo();
    if (!info.available) {
      this.set(bot, { state: 'unavailable', progress: null, detail: info.error });
      throw new HttpError(503, 'computer_unavailable');
    }
    this.row(bot.id);
    const full = (this.ctx.db.prepare('SELECT disk_full FROM computers WHERE bot_id = ?').get(bot.id) as { disk_full: number }).disk_full;
    if (full) {
      this.set(bot, { state: 'disk_full', progress: null, detail: null });
      throw new HttpError(409, 'disk_full');
    }
    try {
      if (!this.image.present) {
        this.set(bot, { state: 'preparing', progress: 0, detail: 'image' });
        await this.buildImage(false, (p) => this.set(bot, { state: 'preparing', progress: p, detail: 'image' }));
      }
      const limits = this.limits(bot.id);
      const forwards = this.forwards(bot.userId);
      const net = networkArgs(info, forwards);
      const want = {
        'advence.bot': bot.id,
        'advence.limits': `${limits.cpus}/${limits.memoryMb}`,
        'advence.forwards': forwards.join(','),
        'advence.gpu': String(this.gpuPresent),
        'advence.image': this.imageName,
      };
      let c = await this.runtime.inspect(name);
      if (c && Object.entries(want).some(([k, v]) => c!.labels[k] !== v)) {
        await this.runtime.remove(name);
        c = null;
      }
      if (!c) {
        this.set(bot, { state: 'preparing', progress: null, detail: 'container' });
        await this.runtime.setSecret(vncSecretName(bot.id), this.vncPassword(bot.id));
        await this.runtime.create({
          name, image: this.imageName, volume: botVolume(bot.id), vncSecret: vncSecretName(bot.id),
          cpus: limits.cpus, memoryMb: limits.memoryMb, gpu: this.gpuPresent, network: net.args, labels: want,
        });
      }
      if (!c?.running) {
        this.set(bot, { state: 'starting', progress: null, detail: null });
        await this.runtime.start(name);
        const deadline = Date.now() + START_TIMEOUT_MS;
        for (;;) {
          const i = await this.runtime.inspect(name);
          if (i?.running && i.vncPort) break;
          if (Date.now() > deadline) throw new Error('the computer did not start in time');
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      this.set(bot, { state: 'running', progress: null, detail: null });
      return name;
    } catch (e) {
      if (e instanceof HttpError) {
        this.set(bot, { state: 'error', progress: null, detail: e.code });
        throw e;
      }
      this.ctx.log.warn({ bot: bot.id, err: (e as Error).message }, 'computer start failed');
      this.set(bot, { state: 'error', progress: null, detail: 'start_failed' });
      throw new HttpError(503, 'computer_start_failed');
    }
  }

  async stop(bot: BotRef): Promise<void> {
    this.release(bot.id);
    await this.runtime.stop(containerName(bot.id));
    this.set(bot, { state: 'stopped', progress: null, detail: null });
  }

  /** A deleted Bot's computer is stopped; its container and home volume are kept (FR-BOT-01). */
  async archive(bot: BotRef): Promise<void> {
    if (!(await this.runtimeInfo()).available) return;
    await this.stop(bot).catch(() => undefined);
    await this.runtime.removeSecret(vncSecretName(bot.id)).catch(() => undefined);
    this.live.delete(bot.id);
  }

  async isRunning(botId: string): Promise<boolean> {
    if (!(await this.runtimeInfo()).available) return false;
    return Boolean((await this.runtime.inspect(containerName(botId)).catch(() => null))?.running);
  }

  // ---------------------------------------------------------------- live view and take-over
  private vncPassword(botId: string): string {
    let p = this.ctx.secrets.get(vncKey(botId));
    if (!p) {
      // RFB VncAuth uses the first 8 characters.
      p = randomBytes(6).toString('base64url');
      this.ctx.secrets.set(vncKey(botId), p);
    }
    return p;
  }

  async vnc(botId: string): Promise<{ port: number; password: string }> {
    const i = await this.runtime.inspect(containerName(botId));
    if (!i?.running || !i.vncPort) throw new HttpError(409, 'computer_not_running');
    return { port: i.vncPort, password: this.vncPassword(botId) };
  }

  password(botId: string): string {
    return this.vncPassword(botId);
  }

  /** The owner takes the mouse and keyboard; the Bot's computer actions wait (FR-UI-05). */
  takeOver(bot: BotRef): ComputerState {
    if (!this.takeovers.has(bot.id)) {
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      this.takeovers.set(bot.id, { release, done });
      this.ctx.bus.publish(bot.userId, COMPUTER_EVENTS.computerUpdated, this.state(bot.id));
    }
    return this.state(bot.id);
  }

  handBack(bot: BotRef): ComputerState {
    this.release(bot.id);
    this.ctx.bus.publish(bot.userId, COMPUTER_EVENTS.computerUpdated, this.state(bot.id));
    return this.state(bot.id);
  }

  private release(botId: string): void {
    const t = this.takeovers.get(botId);
    if (t) {
      this.takeovers.delete(botId);
      t.release();
    }
  }

  /** Resolves when nobody has taken over the computer. */
  async whenFree(botId: string, signal: AbortSignal): Promise<void> {
    for (let t = this.takeovers.get(botId); t; t = this.takeovers.get(botId)) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('aborted'));
        signal.addEventListener('abort', abort, { once: true });
        void t!.done.then(() => {
          signal.removeEventListener('abort', abort);
          resolve();
        });
      });
    }
  }

  // ---------------------------------------------------------------- commands in the computer
  exec(botId: string, argv: string[], o: ExecOptions): ProcessRun {
    return this.runtime.exec(containerName(botId), argv, o);
  }

  /** Disk limit watchdog (FR-PC-05): a computer over its limit is stopped and marked. */
  async checkDisks(): Promise<void> {
    if (!this.info?.available) return;
    const rows = this.ctx.db.prepare('SELECT c.bot_id, b.user_id FROM computers c JOIN bots b ON b.id = c.bot_id WHERE c.disk_full = 0 AND b.archived_at IS NULL').all() as { bot_id: string; user_id: string }[];
    for (const r of rows) {
      const name = containerName(r.bot_id);
      const i = await this.runtime.inspect(name).catch(() => null);
      if (!i?.running) continue;
      const used = await this.runtime.diskUsage(name).catch(() => 0);
      if (used > this.limits(r.bot_id).diskGb * 1024 ** 3) {
        this.ctx.log.warn({ bot: r.bot_id, used }, 'computer over its disk limit; stopping it');
        this.ctx.db.prepare('UPDATE computers SET disk_full = 1 WHERE bot_id = ?').run(r.bot_id);
        await this.runtime.stop(name);
        this.set({ id: r.bot_id, userId: r.user_id }, { state: 'disk_full', progress: null, detail: null });
      }
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.ac.abort();
    for (const id of [...this.takeovers.keys()]) this.release(id);
  }
}
