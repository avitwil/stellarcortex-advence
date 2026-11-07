// In-memory container runtime for tests (FR-PC-*): records every container spec, runs `exec`
// locally in a per-Bot home folder with fake xdotool/import on PATH, and serves a fake
// websockify for the live view.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ContainerInfo, ContainerRuntime, ContainerSpec, ExecOptions, InteractiveCommand, RuntimeInfo } from '../computer/runtime.js';
import type { ProcessRun } from '../models/host.js';

export const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

export class FakeRuntime implements ContainerRuntime {
  available = true;
  gpuPresent = false;
  imagePresent = true;
  buildDelayMs = 0;
  disk = 0;
  containers = new Map<string, { spec: ContainerSpec; running: boolean }>();
  secrets = new Map<string, string>();
  created: ContainerSpec[] = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'advence-fakert-'));
  bin = path.join(this.root, 'bin');
  inputLog = path.join(this.root, 'input.log');
  vncPort = 0;
  vncFrames: Buffer[] = [];
  /** Speak a minimal RFB 3.8 server instead of echoing, for the browser live view test. */
  rfb = false;
  rfbEvents: { type: 'key' | 'pointer'; data: number[] }[] = [];
  rfbClients = 0;
  private http!: http.Server;

  static async start(): Promise<FakeRuntime> {
    const r = new FakeRuntime();
    fs.mkdirSync(r.bin);
    fs.writeFileSync(path.join(r.bin, 'xdotool'), `#!/bin/sh\necho "xdotool $*" >> "${r.inputLog}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(r.bin, 'import'), `#!/bin/sh\nprintf '${[...FAKE_JPEG].map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('')}'\n`, { mode: 0o755 });
    // Fake websockify: echoes RFB bytes back, prefixed with "echo:".
    r.http = http.createServer();
    const wss = new WebSocketServer({ server: r.http });
    wss.on('connection', (ws) => {
      if (r.rfb) return fakeRfb(ws, r);
      ws.on('message', (m: Buffer) => {
        r.vncFrames.push(Buffer.from(m));
        ws.send(Buffer.concat([Buffer.from('echo:'), Buffer.from(m)]));
      });
    });
    await new Promise<void>((res) => r.http.listen(0, '127.0.0.1', () => res()));
    r.vncPort = (r.http.address() as { port: number }).port;
    return r;
  }

  home(name: string): string {
    const d = path.join(this.root, 'homes', this.containers.get(name)?.spec.volume ?? name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  close(): void {
    this.http.closeAllConnections();
    this.http.close();
  }

  /** Windows/macOS: the Podman machine is stopped until startMachine() */
  machineStopped = false;
  machineStarts = 0;
  async startMachine(): Promise<boolean> {
    this.machineStarts++;
    this.machineStopped = false;
    return true;
  }
  async info(): Promise<RuntimeInfo> {
    if (this.machineStopped) return { available: false, version: null, error: 'runtime_not_running', rootless: false, pasta: false };
    return this.available
      ? { available: true, version: '5.4.0', error: null, rootless: true, pasta: true }
      : { available: false, version: null, error: 'runtime_missing', rootless: false, pasta: false };
  }
  async gpu() { return this.gpuPresent; }
  async imageExists() { return this.imagePresent; }
  async buildImage(_dir: string, _image: string, onProgress: (p: number) => void): Promise<void> {
    onProgress(0.5);
    await new Promise((r) => setTimeout(r, this.buildDelayMs));
    this.imagePresent = true;
    onProgress(1);
  }
  async inspect(name: string): Promise<ContainerInfo | null> {
    const c = this.containers.get(name);
    return c ? { running: c.running, vncPort: c.running ? this.vncPort : null, labels: c.spec.labels } : null;
  }
  async create(spec: ContainerSpec): Promise<void> {
    if (this.containers.has(spec.name)) throw new Error('exists');
    this.created.push(spec);
    this.containers.set(spec.name, { spec, running: false });
  }
  async start(name: string): Promise<void> {
    const c = this.containers.get(name);
    if (!c) throw new Error('no such container');
    c.running = true;
  }
  async stop(name: string): Promise<void> {
    const c = this.containers.get(name);
    if (c) c.running = false;
  }
  async remove(name: string): Promise<void> {
    this.containers.delete(name);
  }
  async setSecret(name: string, value: string): Promise<void> {
    this.secrets.set(name, value);
  }
  async removeSecret(name: string): Promise<void> {
    this.secrets.delete(name);
  }
  exec(name: string, argv: string[], o: ExecOptions): ProcessRun {
    if (!this.containers.get(name)?.running) throw new Error('not running');
    const p = spawn(argv[0]!, argv.slice(1), { cwd: this.home(name), env: { PATH: `${this.bin}:${process.env.PATH}`, HOME: this.home(name), ...o.env }, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    p.on('error', () => undefined);
    p.stdin.end(o.stdin ?? '');
    const done = new Promise<{ code: number; stderr: string }>((r) => p.on('close', (code) => r({ code: code ?? -1, stderr })));
    return { lines: readline.createInterface({ input: p.stdout }), done };
  }
  interactive(name: string, argv: string[], env: Record<string, string>): InteractiveCommand {
    if (!this.containers.get(name)?.running) throw new Error('not running');
    return { command: argv[0]!, args: argv.slice(1), env: { PATH: `${this.bin}:${process.env.PATH}`, HOME: this.home(name), ...env }, cwd: this.home(name) };
  }
  async diskUsage() { return this.disk; }
}

/**
 * Minimal RFB 3.8 server (security type None, one raw 64x48 frame) that records the key and
 * pointer events a viewer sends, so tests can tell view-only from take-over (FR-UI-05).
 */
function fakeRfb(ws: WebSocket, r: FakeRuntime): void {
  const W = 64;
  const H = 48;
  r.rfbClients++;
  let buf = Buffer.alloc(0);
  let stage: 'version' | 'security' | 'init' | 'normal' = 'version';
  let sentFrame = false;
  ws.send(Buffer.from('RFB 003.008\n'));
  ws.on('message', (m: Buffer) => {
    buf = Buffer.concat([buf, Buffer.from(m)]);
    for (;;) {
      if (stage === 'version') {
        if (buf.length < 12) return;
        buf = buf.subarray(12);
        stage = 'security';
        ws.send(Buffer.from([1, 1])); // one security type: None
      } else if (stage === 'security') {
        if (buf.length < 1) return;
        buf = buf.subarray(1);
        stage = 'init';
        ws.send(Buffer.from([0, 0, 0, 0])); // SecurityResult OK
      } else if (stage === 'init') {
        if (buf.length < 1) return;
        buf = buf.subarray(1);
        stage = 'normal';
        const name = Buffer.from('bot');
        const init = Buffer.alloc(24 + name.length);
        init.writeUInt16BE(W, 0);
        init.writeUInt16BE(H, 2);
        Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
        init.writeUInt32BE(name.length, 20);
        name.copy(init, 24);
        ws.send(init);
      } else {
        if (buf.length < 1) return;
        const t = buf[0]!;
        const need = t === 0 ? 20 : t === 2 ? (buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : Infinity) : t === 3 ? 10 : t === 4 ? 8 : t === 5 ? 6 : t === 6 ? (buf.length >= 8 ? 8 + buf.readUInt32BE(4) : Infinity) : -1;
        if (need < 0) {
          buf = Buffer.alloc(0);
          return;
        }
        if (buf.length < need) return;
        const msg = buf.subarray(0, need);
        buf = buf.subarray(need);
        if (t === 4) r.rfbEvents.push({ type: 'key', data: [...msg] });
        if (t === 5) r.rfbEvents.push({ type: 'pointer', data: [...msg] });
        if (t === 3 && !sentFrame) {
          sentFrame = true;
          const head = Buffer.alloc(16);
          head.writeUInt8(0, 0);
          head.writeUInt16BE(1, 2);
          head.writeUInt16BE(W, 8);
          head.writeUInt16BE(H, 10);
          head.writeInt32BE(0, 12); // Raw
          ws.send(Buffer.concat([head, Buffer.alloc(W * H * 4, 0x80)]));
        }
      }
    }
  });
}
