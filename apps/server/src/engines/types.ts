// Coding engine interface (D-08, FR-CODE-01): start, send, stream, stop, resume. Adapters for the
// Claude Agent SDK, the Codex CLI and OpenCode run inside the Bot's computer (FR-CODE-02).
import type { Engine, EngineStep, ModelSourceKind } from '@advence/protocol';
import type { ProcessHost, ProcessRun } from '../models/host.js';
import type { Usage } from '../models/types.js';

export type EngineEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'step'; step: EngineStep }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; ok: boolean; text: string; error: string | null };

/** What an engine needs from the Bot's model source; secrets reach the process by env name only. */
export interface EngineAuth {
  kind: ModelSourceKind;
  baseUrl: string | null;
  secret: string;
  model: string | null;
}

export interface EngineStart {
  host: ProcessHost;
  botId: string;
  /** working directory inside the Bot's computer */
  cwd: string;
  auth: EngineAuth;
  signal: AbortSignal;
  /** test hook: Anthropic API base URL */
  anthropicBaseUrl?: string;
}

export interface EngineSession {
  readonly engine: Engine;
  /** the engine's own session id, known after the first turn starts */
  readonly sessionId: string | null;
  /** starts a turn with this prompt */
  send(prompt: string): void;
  /** events of the current turn; ends with 'done' */
  stream(): AsyncIterable<EngineEvent>;
  stop(): void;
}

export interface CodingEngine {
  readonly id: Engine;
  /** source kinds this engine can use */
  supports(kind: ModelSourceKind): boolean;
  start(o: EngineStart): EngineSession;
  resume(sessionId: string, o: EngineStart): EngineSession;
}

export class EngineError extends Error {
  constructor(readonly code: 'engine_source_mismatch' | 'engine_failed' | 'engine_missing', message: string) {
    super(message);
  }
}

export const CLIP = 20_000;
export const clip = (s: string, n = CLIP) => (s.length > n ? `${s.slice(0, n)}\n…` : s);

/** Common turn loop: one engine process per turn, JSONL on stdout, parsed per adapter. */
export abstract class TurnSession implements EngineSession {
  abstract readonly engine: Engine;
  sessionId: string | null;
  private run: ProcessRun | null = null;
  private ac: AbortController | null = null;
  protected text = '';
  protected error: string | null = null;

  constructor(protected o: EngineStart, resume: string | null) {
    this.sessionId = resume;
  }

  protected abstract launch(prompt: string, signal: AbortSignal): ProcessRun;
  protected abstract parse(line: unknown): EngineEvent[];
  protected exitError(code: number, stderr: string): string {
    if (/not (logged|signed) in|unauthori[sz]ed|401|invalid.*(token|key)|authentication/i.test(stderr)) return 'auth';
    if (/rate.?limit|usage limit|429/i.test(stderr)) return 'rate_limited';
    if (/ENOENT|not found|command not found/i.test(stderr)) return 'engine_missing';
    return `exit_${code}`;
  }

  send(prompt: string): void {
    this.ac = new AbortController();
    const onAbort = () => this.ac?.abort();
    this.o.signal.addEventListener('abort', onAbort, { once: true });
    this.text = '';
    this.error = null;
    this.run = this.launch(prompt, this.ac.signal);
  }

  async *stream(): AsyncIterable<EngineEvent> {
    if (!this.run) throw new EngineError('engine_failed', 'send() first');
    const run = this.run;
    for await (const line of run.lines) {
      let j: unknown;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      for (const ev of this.parse(j)) {
        if (ev.type === 'session') this.sessionId = ev.id;
        if (ev.type === 'text') this.text += ev.text;
        yield ev;
      }
    }
    const { code, stderr } = await run.done;
    const stopped = this.ac?.signal.aborted ?? false;
    const error = stopped ? 'stopped' : this.error ?? (code !== 0 ? this.exitError(code, stderr) : null);
    yield { type: 'done', ok: !error, text: this.text, error };
  }

  stop(): void {
    this.ac?.abort();
  }
}

export type HostRun = (o: EngineStart, argv: string[], stdin: string, env: Record<string, string>, signal: AbortSignal) => ProcessRun;
export const hostRun: HostRun = (o, argv, stdin, env, signal) => o.host.run({ botId: o.botId, cwd: o.cwd, argv, stdin, env, signal });
