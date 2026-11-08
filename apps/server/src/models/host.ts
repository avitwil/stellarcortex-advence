// Where subscription CLIs run (D-08: inside the Bot's container). The Podman host runs each
// turn in a throwaway container from the bot-computer image with only the Bot's home volume.
// Secrets are passed by environment name, never on the command line (NFR-SEC-09).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { VERSION } from '../config.js';

export interface RunSpec {
  /** Bot whose home volume the command runs in. */
  botId: string;
  /** working directory inside the computer (default: the Bot's home) */
  cwd?: string;
  argv: string[];
  stdin: string;
  /** Extra environment for the command (secret values allowed). */
  env: Record<string, string>;
  signal: AbortSignal;
}

export interface ProcessRun {
  lines: AsyncIterable<string>;
  /** Resolves with the exit code and the last stderr lines. */
  done: Promise<{ code: number; stderr: string }>;
}

export interface ProcessHost {
  run(spec: RunSpec): ProcessRun;
}

export function runProcess(cmd: string, args: string[], env: NodeJS.ProcessEnv, stdin: string, signal: AbortSignal, cwd?: string): ProcessRun {
  const p = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], signal, cwd });
  let stderr = '';
  p.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-4000);
  });
  p.on('error', () => undefined);
  p.stdin.on('error', () => undefined);
  p.stdin.end(stdin);
  const rl = readline.createInterface({ input: p.stdout, crlfDelay: Infinity });
  const done = new Promise<{ code: number; stderr: string }>((resolve) => {
    p.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    p.on('error', (e) => resolve({ code: -1, stderr: e.message }));
  });
  return { lines: rl, done };
}

/** Built locally per server version, never pulled from a registry (D-09). */
export const BOT_IMAGE = `localhost/advence-bot-computer:${VERSION}`;

export function botVolume(botId: string): string {
  return `advence-bot-${botId.replace(/[^A-Za-z0-9_-]/g, '')}-home`;
}

/**
 * Runs the command in the Bot's running computer (`podman exec`), or else in a fresh container
 * of the bot-computer image with only the Bot's home volume (rootless Podman).
 */
export class PodmanHost implements ProcessHost {
  private hooks: { running(botId: string): boolean; container(botId: string): string; network(): string[] } | null = null;
  constructor(private o: { podman?: string; podmanArgs?: string[]; image?: string } = {}) {}

  /** Set by the computer manager so CLIs share the Bot's live computer and its network policy. */
  attach(hooks: { running(botId: string): boolean; container(botId: string): string; network(): string[] }): void {
    this.hooks = hooks;
  }

  run(spec: RunSpec): ProcessRun {
    const envNames = Object.keys(spec.env).filter((k) => /^[A-Z_][A-Z0-9_]*$/.test(k));
    const cwd = spec.cwd ?? '/home/bot';
    const args = this.hooks?.running(spec.botId)
      ? ['exec', '-i', '-w', cwd, ...envNames.flatMap((k) => ['-e', k]), this.hooks.container(spec.botId), '/usr/bin/env', 'PATH=/home/bot/.local/bin:/usr/local/bin:/usr/bin:/bin', ...spec.argv]
      : [
          'run', '--rm', '-i',
          '--security-opt', 'no-new-privileges',
          '--cap-drop', 'all',
          ...(this.hooks?.network() ?? []),
          '-v', `${botVolume(spec.botId)}:/home/bot`,
          '-w', cwd,
          ...envNames.flatMap((k) => ['-e', k]),
          '--entrypoint', '/usr/bin/env',
          this.o.image ?? BOT_IMAGE,
          'PATH=/home/bot/.local/bin:/usr/local/bin:/usr/bin:/bin',
          ...spec.argv,
        ];
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
    for (const k of envNames) env[k] = spec.env[k];
    return runProcess(this.o.podman ?? process.env.ADVENCE_PODMAN ?? 'podman', [...(this.o.podmanArgs ?? []), ...args], env, spec.stdin, spec.signal);
  }
}
