// ChatGPT subscription sign-in (D-07c) through the official Codex CLI's device login, run in a
// container like every other CLI call. The owner opens the URL and enters the code; the
// resulting auth.json is sealed in the secret store and never written to a volume.
import type { DeviceLogin } from '@advence/protocol';
import type { ProcessHost } from './host.js';

const LOGIN_TTL_MS = 20 * 60_000;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const MARK = 'ADVENCE_AUTH:';

export const CODEX_LOGIN_SCRIPT =
  'umask 077; d=$(mktemp -d); CODEX_HOME="$d" codex login --device-auth; r=$?; ' +
  `if [ $r -eq 0 ] && [ -s "$d/auth.json" ]; then printf '${MARK}'; base64 < "$d/auth.json" | tr -d '\\n'; echo; else r=1; fi; rm -rf "$d"; exit $r`;

interface Pending { state: DeviceLogin; ac: AbortController; started: number }

export class CodexLogins {
  private logins = new Map<string, Pending>();
  constructor(private host: ProcessHost, private onToken: (sourceId: string, authJson: string) => void) {}

  get(sourceId: string): DeviceLogin | null {
    const p = this.logins.get(sourceId);
    if (!p) return null;
    if (Date.now() - p.started > LOGIN_TTL_MS && p.state.state !== 'done') {
      p.ac.abort();
      p.state = { ...p.state, state: 'failed', error: 'expired' };
    }
    return p.state;
  }

  /** Starts a login and resolves once the CLI printed the URL and code (or failed). */
  async start(sourceId: string): Promise<DeviceLogin> {
    this.logins.get(sourceId)?.ac.abort();
    const ac = new AbortController();
    const p: Pending = { state: { state: 'starting', url: null, code: null, error: null }, ac, started: Date.now() };
    this.logins.set(sourceId, p);
    const run = this.host.run({ botId: `login-${sourceId}`, argv: ['sh', '-c', CODEX_LOGIN_SCRIPT], stdin: '', env: {}, signal: ac.signal });
    let announce!: () => void;
    const shown = new Promise<void>((r) => (announce = r));
    void (async () => {
      let auth = '';
      try {
        for await (const raw of run.lines) {
          const line = raw.replace(ANSI, '').trim();
          if (line.startsWith(MARK)) {
            auth = Buffer.from(line.slice(MARK.length), 'base64').toString('utf8');
            continue;
          }
          const url = /https:\/\/[^\s]+/.exec(line)?.[0];
          const code = /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/.exec(line)?.[0];
          if (url && !p.state.url) p.state = { ...p.state, url };
          if (code && !p.state.code) p.state = { ...p.state, code };
          if (p.state.url && p.state.code && p.state.state === 'starting') {
            p.state = { ...p.state, state: 'waiting' };
            announce();
          }
        }
        const { code } = await run.done;
        let valid = false;
        try {
          valid = code === 0 && typeof JSON.parse(auth) === 'object';
        } catch {
          valid = false;
        }
        if (valid) {
          this.onToken(sourceId, auth);
          p.state = { state: 'done', url: null, code: null, error: null };
        } else p.state = { ...p.state, state: 'failed', error: ac.signal.aborted ? 'cancelled' : 'login_failed' };
      } catch {
        p.state = { ...p.state, state: 'failed', error: 'login_failed' };
      } finally {
        announce();
      }
    })();
    await Promise.race([shown, new Promise((r) => setTimeout(r, 30_000).unref())]);
    return p.state;
  }

  cancel(sourceId: string): void {
    this.logins.get(sourceId)?.ac.abort();
    this.logins.delete(sourceId);
  }

  cancelAll(): void {
    for (const p of this.logins.values()) p.ac.abort();
    this.logins.clear();
  }
}
