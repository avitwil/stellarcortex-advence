#!/usr/bin/env node
// StellarCortex Advence server launcher (D-24, NFR-REL-02). The OS service runs this file from the
// install folder. It starts the current server version and finishes updates the server staged:
// it backs up the database, starts the new version, waits for its health signal, then switches
// to it, or rolls back to the previous version and database when the health check fails.
//
// Install folder:
//   current             the version that runs (one line)
//   pending.json        a staged update: { version, db }
//   trial.json          a new version is on trial (written after the database backup)
//   update-failed.json  the last update that rolled back
//   versions/<v>/       one extracted release bundle per version
//   launcher.mjs        this file (replaced after a successful update)
// Plain Node, no dependencies: it must run before any bundle is known to work.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Exit code the server uses to ask for a restart into a staged update. */
export const UPDATE_EXIT = 75;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const DB_PARTS = ['', '-wal', '-shm'];
const KEEP_VERSIONS = 2;

const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    return null;
  }
};

function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export const entryOf = (root, v) => path.join(root, 'versions', v, 'server', 'dist', 'main.js');

/** Copies the SQLite file with its WAL and shared-memory files; parts that do not exist are removed at the target. */
export function copyDb(from, to) {
  for (const p of DB_PARTS) {
    if (fs.existsSync(from + p)) fs.copyFileSync(from + p, to + p);
    else fs.rmSync(to + p, { force: true });
  }
}

function readPending(root) {
  const raw = readText(path.join(root, 'pending.json'));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    if (typeof p.version === 'string' && VERSION_RE.test(p.version) && typeof p.db === 'string' && path.isAbsolute(p.db)) return p;
  } catch {
    /* fall through */
  }
  return { invalid: true };
}

function exitOf(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode ?? 1);
    else child.once('exit', (code) => resolve(code ?? 1));
  });
}

async function stop(child, graceMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const t = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await exitOf(child);
  clearTimeout(t);
}

function pruneVersions(root, keep) {
  const dir = path.join(root, 'versions');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => VERSION_RE.test(n));
  } catch {
    return;
  }
  const byAge = names.map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { n } of byAge.slice(KEEP_VERSIONS)) if (!keep.includes(n)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
}

/**
 * Runs the server until it exits for a reason other than an update, and returns its exit code.
 * `o.healthMs` bounds how long a new version may take to report ready.
 */
export async function launch(root, o = {}) {
  const log = o.log ?? ((m) => process.stderr.write(`advence-launcher: ${m}\n`));
  const healthMs = o.healthMs ?? 120_000;
  const node = o.node ?? process.execPath;
  let child = null;
  let stopping = false;
  const onSignal = () => {
    stopping = true;
    if (child) void stop(child);
  };
  if (o.signals !== false) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }
  const start = (v) =>
    spawn(node, [entryOf(root, v), 'serve'], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ADVENCE_LAUNCHER: '1', ADVENCE_INSTALL_ROOT: root },
    });
  try {
    for (;;) {
      if (stopping) return 0;
      const pending = readPending(root);
      if (pending?.invalid) {
        log('ignoring an unreadable pending update');
        fs.rmSync(path.join(root, 'pending.json'), { force: true });
      } else if (pending) {
        const from = readText(path.join(root, 'current'));
        const backup = `${pending.db}.pre-${pending.version}`;
        const trialFile = path.join(root, 'trial.json');
        const fail = async (reason) => {
          if (child) await stop(child);
          child = null;
          copyDb(backup, pending.db);
          fs.rmSync(path.join(root, 'pending.json'), { force: true });
          fs.rmSync(trialFile, { force: true });
          if (pending.version !== from) fs.rmSync(path.join(root, 'versions', pending.version), { recursive: true, force: true });
          writeAtomic(path.join(root, 'update-failed.json'), `${JSON.stringify({ version: pending.version, from, at: new Date().toISOString(), reason })}\n`);
          log(`update to ${pending.version} failed (${reason}); rolled back to ${from}`);
        };
        let trial = null;
        try {
          trial = JSON.parse(readText(trialFile) ?? 'null');
        } catch {
          /* unreadable: treated as no trial */
        }
        if (trial && trial.version === pending.version && fs.existsSync(backup)) {
          // The launcher stopped (power loss, kill) while this version was on trial. It may have
          // changed the database already, so the backup from before the trial is restored and is
          // never overwritten by a second backup.
          await fail('interrupted during its health check');
        } else if (!fs.existsSync(entryOf(root, pending.version))) {
          fs.rmSync(path.join(root, 'pending.json'), { force: true });
          fs.rmSync(trialFile, { force: true });
          log(`staged version ${pending.version} is missing`);
        } else {
          // The previous server has exited, so the database is closed and safe to copy.
          copyDb(pending.db, backup);
          writeAtomic(trialFile, `${JSON.stringify({ version: pending.version, at: new Date().toISOString() })}\n`);
          child = start(pending.version);
          const outcome = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ ok: false, reason: 'no health signal' }), healthMs);
            child.on('message', (m) => {
              if (m && m.type === 'ready') {
                clearTimeout(timer);
                resolve(m.version === pending.version ? { ok: true } : { ok: false, reason: `reported version ${m.version}` });
              }
            });
            child.once('exit', (code) => {
              clearTimeout(timer);
              resolve({ ok: false, reason: `exited with ${code}` });
            });
          });
          if (outcome.ok) {
            writeAtomic(path.join(root, 'current'), `${pending.version}\n`);
            const next = path.join(root, 'versions', pending.version, 'launcher.mjs');
            if (fs.existsSync(next)) writeAtomic(path.join(root, 'launcher.mjs'), fs.readFileSync(next, 'utf8'));
            fs.rmSync(path.join(root, 'pending.json'), { force: true });
            fs.rmSync(trialFile, { force: true });
            fs.rmSync(path.join(root, 'update-failed.json'), { force: true });
            pruneVersions(root, [pending.version, from]);
            log(`updated ${from} -> ${pending.version}`);
            const code = await exitOf(child);
            child = null;
            if (code === UPDATE_EXIT) continue;
            return code;
          }
          await fail(outcome.reason);
        }
      }
      if (stopping) return 0;
      const v = readText(path.join(root, 'current'));
      if (!v || !VERSION_RE.test(v) || !fs.existsSync(entryOf(root, v))) {
        log('no runnable version in the install folder');
        return 1;
      }
      child = start(v);
      const code = await exitOf(child);
      child = null;
      if (code !== UPDATE_EXIT || stopping) return stopping ? 0 : code;
    }
  } finally {
    if (o.signals !== false) {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = i > 0 ? path.resolve(process.argv[i + 1]) : path.dirname(fileURLToPath(import.meta.url));
  launch(root).then((code) => process.exit(code), (e) => {
    process.stderr.write(`advence-launcher: ${e.message}\n`);
    process.exit(1);
  });
}
