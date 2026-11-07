// In-memory container runtime for tests (FR-PC-*): records every container spec, runs `exec`
// locally in a per-Bot home folder with fake xdotool/import on PATH, and serves a fake
// websockify for the live view.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';
import type { ContainerInfo, ContainerRuntime, ContainerSpec, ExecOptions, RuntimeInfo } from '../computer/runtime.js';
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
  private http!: http.Server;

  static async start(): Promise<FakeRuntime> {
    const r = new FakeRuntime();
    fs.mkdirSync(r.bin);
    fs.writeFileSync(path.join(r.bin, 'xdotool'), `#!/bin/sh\necho "xdotool $*" >> "${r.inputLog}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(r.bin, 'import'), `#!/bin/sh\nprintf '${[...FAKE_JPEG].map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('')}'\n`, { mode: 0o755 });
    // Fake websockify: echoes RFB bytes back, prefixed with "echo:".
    r.http = http.createServer();
    const wss = new WebSocketServer({ server: r.http });
    wss.on('connection', (ws) => ws.on('message', (m: Buffer) => {
      r.vncFrames.push(Buffer.from(m));
      ws.send(Buffer.concat([Buffer.from('echo:'), Buffer.from(m)]));
    }));
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

  async info(): Promise<RuntimeInfo> {
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
  async diskUsage() { return this.disk; }
}
