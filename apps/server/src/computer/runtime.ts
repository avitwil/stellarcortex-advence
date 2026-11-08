// Container runtime for Bot computers (D-09, D-10): Podman on every OS, never Docker Desktop.
// Everything goes through the `podman` CLI; secret values travel on stdin or in the child's
// environment by name, never on the command line (NFR-SEC-09).
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { ProcessRun } from '../models/host.js';

export interface ContainerSpec {
  name: string;
  image: string;
  volume: string;
  /** podman secret holding the VNC password, mounted at /run/secrets/vnc_password */
  vncSecret: string;
  cpus: number;
  memoryMb: number;
  gpu: boolean;
  network: string[];
  labels: Record<string, string>;
}

export interface ContainerInfo {
  running: boolean;
  /** host loopback port of noVNC/websockify, when running */
  vncPort: number | null;
  labels: Record<string, string>;
}

export interface RuntimeInfo {
  available: boolean;
  version: string | null;
  error: string | null;
  rootless: boolean;
  pasta: boolean;
}

export interface ExecOptions {
  stdin?: string;
  /** values are passed through the podman process environment, by name only */
  env?: Record<string, string>;
  cwd?: string;
  signal: AbortSignal;
}

export interface InteractiveCommand { command: string; args: string[]; env: Record<string, string>; cwd?: string }

export interface ContainerRuntime {
  info(): Promise<RuntimeInfo>;
  /** an NVIDIA GPU is exposed through CDI (FR-PC-08) */
  gpu(): Promise<boolean>;
  imageExists(image: string): Promise<boolean>;
  buildImage(contextDir: string, image: string, onProgress: (p: number) => void, signal: AbortSignal): Promise<void>;
  inspect(name: string): Promise<ContainerInfo | null>;
  create(spec: ContainerSpec): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
  setSecret(name: string, value: string): Promise<void>;
  removeSecret(name: string): Promise<void>;
  exec(name: string, argv: string[], o: ExecOptions): ProcessRun;
  /** How to start a long-lived process in the container with stdin and stdout attached (MCP stdio servers). */
  interactive(name: string, argv: string[], env: Record<string, string>): InteractiveCommand;
  /** bytes used under /home/bot (the Bot's volume) */
  diskUsage(name: string): Promise<number>;
  /** Windows and macOS: starts the Podman machine VM; true when it is running */
  startMachine?(): Promise<boolean>;
}

export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

interface Out { code: number; stdout: string; stderr: string }

function lines(p: ReturnType<typeof spawn>, stdin: string | undefined): ProcessRun {
  let stderr = '';
  p.stderr!.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-4000);
  });
  p.on('error', () => undefined);
  p.stdin!.on('error', () => undefined);
  p.stdin!.end(stdin ?? '');
  const rl = readline.createInterface({ input: p.stdout!, crlfDelay: Infinity });
  const done = new Promise<{ code: number; stderr: string }>((resolve) => {
    p.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    p.on('error', (e) => resolve({ code: -1, stderr: e.message }));
  });
  return { lines: rl, done };
}

export class PodmanRuntime implements ContainerRuntime {
  /** `pre` goes before every Podman argument (tests start a fake Podman through a shell). */
  constructor(private bin = process.env.ADVENCE_PODMAN ?? 'podman', private pre: string[] = []) {}

  private baseEnv(): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CONTAINER_HOST', 'CONTAINER_CONNECTION', 'SystemRoot', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TEMP', 'TMP']) {
      if (process.env[k]) e[k] = process.env[k];
    }
    return e;
  }

  private run(args: string[], o: { stdin?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Out> {
    return new Promise((resolve) => {
      const p = spawn(this.bin, [...this.pre, ...args], { env: { ...this.baseEnv(), ...o.env }, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, timeout: o.timeoutMs ?? 120_000 });
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString('utf8')).slice(-1_000_000)));
      p.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString('utf8')).slice(-8000)));
      p.stdin.on('error', () => undefined);
      p.stdin.end(o.stdin ?? '');
      p.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
      p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  private async must(args: string[], o: Parameters<PodmanRuntime['run']>[1] = {}): Promise<string> {
    const r = await this.run(args, o);
    if (r.code !== 0) throw new Error(`podman ${args[0]} failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
    return r.stdout;
  }

  async info(): Promise<RuntimeInfo> {
    const r = await this.run(['info', '--format', 'json'], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      const missing = r.code === -1 && /ENOENT/.test(r.stderr);
      return { available: false, version: null, error: missing ? 'runtime_missing' : 'runtime_not_running', rootless: false, pasta: false };
    }
    try {
      const j = JSON.parse(r.stdout);
      return {
        available: true,
        version: String(j.version?.Version ?? ''),
        error: null,
        rootless: Boolean(j.host?.security?.rootless),
        pasta: Boolean(j.host?.pasta?.executable),
      };
    } catch {
      return { available: true, version: null, error: null, rootless: false, pasta: false };
    }
  }

  async gpu(): Promise<boolean> {
    // CDI specs generated by nvidia-ctk; Podman resolves nvidia.com/gpu=all from them.
    const r = await this.run(['info', '--format', '{{json .Host.CDISpecDirs}}'], { timeoutMs: 15_000 }).catch(() => null);
    if (!r || r.code !== 0) return false;
    const fs = await import('node:fs');
    const dirs: string[] = (() => {
      try {
        return (JSON.parse(r.stdout) as string[] | null) ?? ['/etc/cdi', '/var/run/cdi'];
      } catch {
        return ['/etc/cdi', '/var/run/cdi'];
      }
    })();
    for (const d of dirs) {
      try {
        if (fs.readdirSync(d).some((f) => /nvidia/i.test(f))) return true;
      } catch {
        /* not there */
      }
    }
    return false;
  }

  async imageExists(image: string): Promise<boolean> {
    return (await this.run(['image', 'exists', image], { timeoutMs: 30_000 })).code === 0;
  }

  async startMachine(): Promise<boolean> {
    return (await this.run(['machine', 'start'], { timeoutMs: 300_000 })).code === 0;
  }

  async buildImage(contextDir: string, image: string, onProgress: (p: number) => void, signal: AbortSignal): Promise<void> {
    const p = spawn(this.bin, [...this.pre, 'build', '--pull=missing', '-t', image, contextDir], { env: this.baseEnv(), stdio: ['ignore', 'pipe', 'pipe'], signal });
    const tail: string[] = [];
    const onLine = (l: string) => {
      tail.push(l);
      if (tail.length > 20) tail.shift();
      const m = /^STEP (\d+)\/(\d+)/.exec(l);
      if (m) onProgress(Math.min(0.99, (Number(m[1]) - 1) / Number(m[2])));
    };
    readline.createInterface({ input: p.stdout }).on('line', onLine);
    readline.createInterface({ input: p.stderr }).on('line', onLine);
    const code = await new Promise<number>((resolve) => {
      p.on('error', () => resolve(-1));
      p.on('close', (c) => resolve(c ?? -1));
    });
    if (code !== 0) throw new Error(`image build failed: ${tail.slice(-3).join(' ')}`);
    onProgress(1);
  }

  async inspect(name: string): Promise<ContainerInfo | null> {
    const r = await this.run(['container', 'inspect', name, '--format', 'json'], { timeoutMs: 30_000 });
    if (r.code !== 0) return null;
    const j = (JSON.parse(r.stdout) as any[])[0];
    if (!j) return null;
    const running = Boolean(j.State?.Running);
    const ports = j.NetworkSettings?.Ports?.['6080/tcp'] as { HostPort?: string }[] | null | undefined;
    const port = Number(ports?.[0]?.HostPort ?? 0);
    return { running, vncPort: running && port > 0 ? port : null, labels: (j.Config?.Labels ?? {}) as Record<string, string> };
  }

  async create(s: ContainerSpec): Promise<void> {
    const args = [
      'create', '--name', s.name,
      ...Object.entries(s.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      // NFR-SEC-08 / FR-PC-04: non-root image user, no new privileges, default seccomp, no
      // host mounts except the Bot's own volume, no Podman socket inside. CAP_SYS_CHROOT is the
      // one capability kept: Chromium's namespace sandbox needs it to start its zygote (DL-054).
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'all',
      '--cap-add', 'SYS_CHROOT',
      '--pids-limit', '4096',
      '--cpus', String(s.cpus),
      '--memory', `${s.memoryMb}m`,
      '--memory-swap', `${s.memoryMb}m`,
      '--shm-size', '1g',
      '--secret', `${s.vncSecret},target=vnc_password,mode=0400,uid=1000`,
      '-v', `${s.volume}:/home/bot`,
      // noVNC is published on the host loopback only (NFR-SEC-08).
      '-p', '127.0.0.1::6080',
      ...s.network,
      ...(s.gpu ? ['--device', 'nvidia.com/gpu=all'] : []),
      '--hostname', 'bot-computer',
      s.image,
    ];
    await this.must(args);
  }

  async start(name: string): Promise<void> {
    await this.must(['start', name]);
  }

  async stop(name: string): Promise<void> {
    await this.run(['stop', '-t', '10', name]);
  }

  async remove(name: string): Promise<void> {
    await this.run(['rm', '-f', '-t', '5', name]);
  }

  async setSecret(name: string, value: string): Promise<void> {
    await this.run(['secret', 'rm', name]);
    // `-` (stdin) needs a FIFO, and Node pipes are sockets: pass the value in the child's
    // environment instead, so it is never on the command line.
    await this.must(['secret', 'create', '--env=true', name, 'ADVENCE_SECRET_VALUE'], { env: { ADVENCE_SECRET_VALUE: value } });
  }

  async removeSecret(name: string): Promise<void> {
    await this.run(['secret', 'rm', name]);
  }

  exec(name: string, argv: string[], o: ExecOptions): ProcessRun {
    const names = Object.keys(o.env ?? {}).filter((k) => ENV_NAME.test(k));
    const env: NodeJS.ProcessEnv = this.baseEnv();
    for (const k of names) env[k] = o.env![k];
    const args = ['exec', '-i', ...(o.cwd ? ['-w', o.cwd] : []), ...names.flatMap((k) => ['-e', k]), name, ...argv];
    return lines(spawn(this.bin, [...this.pre, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal }), o.stdin);
  }

  interactive(name: string, argv: string[], extra: Record<string, string>): InteractiveCommand {
    // Secrets travel by name (`-e NAME`) with the value in podman's own environment, never in argv.
    const names = Object.keys(extra).filter((k) => ENV_NAME.test(k));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.baseEnv())) if (v !== undefined) env[k] = v;
    for (const k of names) env[k] = extra[k]!;
    return { command: this.bin, args: [...this.pre, 'exec', '-i', ...names.flatMap((k) => ['-e', k]), name, ...argv], env };
  }

  async diskUsage(name: string): Promise<number> {
    const r = await this.run(['exec', name, 'du', '-sxb', '/home/bot'], { timeoutMs: 120_000 });
    const n = Number(r.stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(n) ? n : 0;
  }
}

/**
 * NFR-SEC-08 network policy. Rootless pasta copies the host's addresses into the container and,
 * with --no-map-gw, gives it no route to the host itself, so the server API is unreachable.
 * Only the loopback ports of the owner's local model servers are forwarded (D-07a).
 * Without pasta the container still cannot reach the host loopback (slirp4netns default).
 */
export function networkArgs(info: RuntimeInfo, forwards: number[]): { args: string[]; isolated: boolean } {
  if (info.rootless && info.pasta) {
    const opts = ['--no-map-gw', ...forwards.flatMap((p) => ['-T', String(p)])];
    return { args: ['--network', `pasta:${opts.join(',')}`], isolated: true };
  }
  if (info.rootless) return { args: ['--network', 'slirp4netns:allow_host_loopback=false'], isolated: false };
  return { args: [], isolated: false };
}
