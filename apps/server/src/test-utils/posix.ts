// The Bot computer is a Linux container, so the commands the server sends it are POSIX shell
// commands. Tests that stand a local folder in for the container run them on the host: as-is on
// Linux and macOS, through Git for Windows' bash on Windows.
import fs from 'node:fs';
import path from 'node:path';

let bash: string | null = null;

/** Git for Windows' bash (ADVENCE_TEST_BASH overrides). Not the WSL bash in System32. */
export function windowsBash(): string {
  if (bash) return bash;
  const candidates = [
    process.env.ADVENCE_TEST_BASH,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('The tests need Git for Windows (bash.exe); set ADVENCE_TEST_BASH to its path.');
  bash = found;
  return found;
}

/** Command and arguments that run `argv` the way the container would. */
export function hostCommand(argv: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: argv[0]!, args: argv.slice(1) };
  return { command: windowsBash(), args: ['-c', 'exec "$@"', 'bash', ...argv] };
}

/** The shell `execSync` should use for POSIX command strings. */
export function posixShell(): string {
  return process.platform === 'win32' ? windowsBash() : '/bin/sh';
}

/** A host path written into a shell script (forward slashes, which Git's bash also accepts). */
export function shPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** The few variables Windows programs need to start at all (none elsewhere). */
export function hostEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return {};
  const e: NodeJS.ProcessEnv = {};
  for (const k of ['SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ComSpec', 'PATHEXT', 'ProgramFiles']) {
    if (process.env[k]) e[k] = process.env[k];
  }
  return e;
}

/** PATH with `dir` first, in the host's list format. */
export function withPath(dir: string): string {
  return `${dir}${path.delimiter}${process.env.PATH ?? ''}`;
}

/**
 * A fake command-line tool written as a POSIX shell script. Returns how to start it: the script
 * itself, or (Windows) bash with the script as its first argument.
 */
export function fakeTool(dir: string, name: string, script: string): { bin: string; args: string[] } {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}`, { mode: 0o755 });
  return process.platform === 'win32' ? { bin: windowsBash(), args: [file] } : { bin: file, args: [] };
}
