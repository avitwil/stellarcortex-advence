// Runs Bot commands on the host instead of in a container, for tests with fake CLIs.
// `home` stands in for /home/bot.
import fs from 'node:fs';
import { runProcess, type ProcessHost, type ProcessRun, type RunSpec } from '../models/host.js';
import { hostCommand, hostEnv, withPath } from './posix.js';

export class LocalHost implements ProcessHost {
  constructor(private o: { binDir: string; cwd?: string; home?: string }) {}
  run(spec: RunSpec): ProcessRun {
    const { command, args } = hostCommand(spec.argv);
    const env: NodeJS.ProcessEnv = { ...hostEnv(), PATH: withPath(this.o.binDir), ...(this.o.home ? { HOME: this.o.home } : {}), ...spec.env };
    let cwd = this.o.cwd;
    if (spec.cwd && this.o.home) {
      cwd = spec.cwd.replace(/^\/home\/bot/, this.o.home);
      fs.mkdirSync(cwd, { recursive: true });
    }
    return runProcess(command, args, env, spec.stdin, spec.signal, cwd);
  }
}
